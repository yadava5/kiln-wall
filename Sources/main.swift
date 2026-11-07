// KilnWall — a local HTML dashboard as the desktop wallpaper, fed live JSON.
//
// One borderless window per screen sits one level below the desktop icons (so above a video
// wallpaper app's window, which sits at the desktop level) and holds a WKWebView showing the chosen design,
// ~/.config/kiln-wall/designs/<design>/index.html. Each JSON line from the feed (Feed.swift) is
// handed to the page as its raw text, window.kiln.update(line), and the design, refresh period (100..1000 ms),
// appearance and temperature unit (settings.json, see Settings.swift), with where the Dock is on
// that display (DockGeometry.swift), as
// window.kiln.config({design, period_ms, appearance, temp_unit, dock}). Whenever nobody
// can see the wallpaper the page is told window.kiln.pause() and the feed is stopped, except
// under a cover (a window or full-screen Space over the desktop): then the feed runs on for a
// grace period at 1 s, its lines kept but not sent, so a quick return shows the latest state at
// once (see coveredGrace).
//
// The page never shows blank (the brief, 2026-11-05: "It can be stale ... but it should not be
// blank"). Every page load is sent the last full state, kept on disk (LastLine), as its first
// line, marked cached, so it draws real figures at once, with no feed and under a cover. A page
// that loads or reloads while nobody sees it is drawn unseen (renderUnseen), not on the return.
// A picture of the page goes over it until it has painted; pictures come only from a page that
// has painted data and are tagged with the light or dark look they show.
//
// The period and design change live, from the menu-bar item (Menu.swift), the global hotkeys ⌃⌥= (faster,
// −100 ms) and ⌃⌥- (slower, +100 ms), or the `kiln-wall` CLI, which writes settings.json.
//
// The macOS desktop picture is kept matched to the wallpaper (Desktop.swift), because Mission
// Control and Space switches show the system's picture, not this window.
import AppKit
import Carbon.HIToolbox
import ImageIO
import os
import ServiceManagement
import UniformTypeIdentifiers
import WebKit

// Every state change:  log stream --predicate 'subsystem == "io.github.yadava5.kilnwall"'
let logger = Logger(subsystem: "io.github.yadava5.kilnwall", category: "host")

func log(_ message: String) {
    logger.notice("\(message, privacy: .public)")
}

enum PauseReason: String, CaseIterable {
    case manual = "paused by you"
    case hidden = "wallpaper hidden"
    case covered = "desktop covered"
    case locked = "screen locked"
    case lowPower = "Low Power Mode"
}

@MainActor
final class KilnWall: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    // Normal windows covering at least this share of a screen count as covering it. The window
    // server alone reports the gaps between tiled windows and the translucent menu bar as visible.
    private static let coveredShare = 0.97
    private static let coveragePoll: TimeInterval = 2
    private static let reloadDebounce: TimeInterval = 0.3
    // Desktop picture updates (see Desktop.swift): this long after a page load, and when paused at
    // most this often.
    private static let desktopAfterLoad: TimeInterval = 8
    private static let snapshotEvery: TimeInterval = 60
    private static let snapshotSettle: TimeInterval = 2
    // A page told a new appearance re-renders at once (Kiln.onPrefs); the designs' longest colour
    // transition is 0.6 s (bento, flightdeck, ledger), so it counts as drawn two frames and this
    // long after the config.
    private static let appearanceSettle: TimeInterval = 0.7
    // Drawing a new look while nobody sees the page (renderUnseen) gives up after this.
    private static let unseenTimeout: TimeInterval = 10
    // Covered: the feed is kept this long at coveredPeriodMs, so a return within it shows the
    // state of a second ago at once. Measured 2026-11-05 (kiln-feed --stream --period-ms 1000,
    // 150 s, load average 2.3-3.5): own CPU 1.17% of a core (0.87-1.43% per 30 s), 2.5% with the
    // ps/netstat/pmset children it forks; a fresh start costs 90 ms of CPU and its first line
    // comes one period later. So a full grace costs ~3 CPU-seconds; 120 s is the brief's "a minute or
    // two", and a cover that outlasts it stops the feed as before.
    private static let coveredGrace: TimeInterval = 120
    private static let coveredPeriodMs = 1000
    // A reloading page's overlay (a snapshot of it before the reload) fades out over this once the
    // page has painted its first line, and goes after overlayTimeout anyway (while it is seen).
    private static let overlayFade: TimeInterval = 0.2
    private static let overlayTimeout: TimeInterval = 3
    // WebKit may not keep a hidden page's pixels in the window. 8b5eb6d measured WebContent's
    // IOSurface memory go volatile at a cover and be purged (back buffers: the tiles the window
    // shows stay in use and never went volatile, measured 2026-11-05 evening); and 480 s into a
    // cover WebKit suspends the process and empties the web view until its first frame after the
    // resume (coverUnseen). So the window is covered with a picture of the page as it goes unseen
    // (covered, locked, hidden) until the page's first frames after resume, also within the grace;
    // the page is snapshotted as it is covered (at most every coverSnapshotEvery) for that picture.
    private static let coverSnapshotEvery: TimeInterval = 10

    private var windows: [CGDirectDisplayID: NSWindow] = [:]
    private var webViews: [CGDirectDisplayID: WKWebView] = [:]
    private var reasons: Set<PauseReason> = []
    // Every reason seen since the wallpaper last paused: was the window unseen meanwhile?
    private var pausedFor: Set<PauseReason> = []
    private var running = false  // page told to animate (and the feed on, its lines sent)
    // Covered, within the grace: the feed runs at coveredPeriodMs and its lines are kept, not sent.
    private var holding = false
    private var graceWork: DispatchWorkItem?
    private var graceStarted = Date()
    private var graceCPU: Double?
    // Counts the wallpaper's pauses, so a picture taken as one began is not put up in another.
    private var pauses = 0
    // Lines kept since the page was last sent one: it is sent `replay.latest()` when it runs again.
    private var heldUnsent = false
    // `look`: what the overlay's picture shows (nil: unknown).
    private var overlays: [CGDirectDisplayID: (view: NSImageView, since: Date, look: Look?)] = [:]
    private var overlayTimeouts: [CGDirectDisplayID: DispatchWorkItem] = [:]
    private var snapshotting: Set<CGDirectDisplayID> = []
    // Test hook, only with KILNWALL_TEST_COVER=1 in the environment: SIGUSR2 flips a forced
    // covered / uncovered that replaces what the window server and the window list say, so the
    // cover path (grace, latest state, overlay) runs without moving anyone's windows.
    private var forcedCover: Bool?
    private var coverageTimer: Timer?
    private var settings = Settings.load()
    private lazy var target = PageTarget.resolve(settings.design)
    private var watcher: FolderWatcher?
    private var settingsWatcher: SettingsWatcher?
    private let hotkeys = Hotkeys()
    private var reloadWork: DispatchWorkItem?
    private var changedPaths: [String] = []
    private var signals: [DispatchSourceSignal] = []
    private var statusItem: NSStatusItem?
    private var menu: KilnMenu?
    // What each display's page shows, so every picture of it is tagged with its look (Look,
    // Desktop.swift). `generation` counts loads, design switches and appearance changes. The page
    // should show `wanted`; `loading` is its latest load; `drawn` is what is known on screen (the
    // load posted {painted}, or two frames and a settle passed after a config). A snapshot is
    // taken, written and set only while drawn and wanted are the same generation.
    private var generation = 0
    private var loading: [CGDirectDisplayID: (gen: Int, look: Look)] = [:]
    private var wanted: [CGDirectDisplayID: (gen: Int, look: Look)] = [:]
    private var drawn: [CGDirectDisplayID: (gen: Int, look: Look)] = [:]
    // Drew a frame since the wallpaper last started running: a snapshot now is of the page as it is.
    private var drawnSinceRun: Set<CGDirectDisplayID> = []
    // A new design or appearance: one snapshot as soon as it has drawn, past the 60 s throttle.
    private var freshDue: Set<CGDirectDisplayID> = []
    // The page's current load has drawn a full line (posted {painted}): only such a page is
    // snapshotted, for the desktop picture or an overlay. A load clears it. At 12:31 on
    // 2026-11-05 a snapshot of a page that had drawn no data (luma std 5.4, past the blank check)
    // covered a reload, and the user saw an empty wallpaper.
    private var painted: Set<CGDirectDisplayID> = []
    // The look ("light" or "dark") this page was last seen to draw "auto" in, from its snapshot.
    private var autoDrawn: [CGDirectDisplayID: Look] = [:]
    // LastLine: when the last state was last written, and the `t` it carried.
    private var lastLineSaved = Date.distantPast
    private var lastLineSavedT: Double?
    // Test instance, KILNWALL_TEST_SHOTS=<folder>: PNGs of what the window shows (testShot).
    private static let testShots: URL? = TestHome.url == nil ? nil
        : ProcessInfo.processInfo.environment["KILNWALL_TEST_SHOTS"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }
    private var shotCount = 0
    // Test instance, KILNWALL_TEST_CAPTURE=<folder>: the window server's copy of each window (TestCapture.swift).
    private var captures: [CGDirectDisplayID: WindowCapture] = [:]
    private var forcedCovers = 0
    private var testSuspended = false
    // Drawing a new look while nobody sees it (renderUnseen): the time limit.
    private var unseen: [CGDirectDisplayID: DispatchWorkItem] = [:]
    // KILNWALL_TEST_HOME: a test instance (see applicationDidFinishLaunching).
    private let testInstance = TestHome.url != nil
    private let feed = Feed()
    // The Dock's position and length per display, sent in the page's config (DockGeometry.swift).
    private let dock = DockWatcher()
    private var acknowledged = 0
    private var scriptErrors = 0
    private var replay = ReplayCache()
    private lazy var desktop = DesktopMatcher(enabled: settings.matchDesktop) { [weak self] in self?.webViews[$0] }
    private var desktopAfterLoadWork: [CGDirectDisplayID: DispatchWorkItem] = [:]
    private var snapshotDue: Set<CGDirectDisplayID> = []
    private var sentSinceSnapshot: Set<CGDirectDisplayID> = []
    private var lastSnapshot: [CGDirectDisplayID: Date] = [:]
    private var runningSince = Date.distantFuture
    private var pausedSince = Date()
    // A page-file change, design switch or menu Reload while the wallpaper was paused: the page is
    // reloaded when it runs again, under the last snapshot, not while nobody can see it.
    private var reloadOnRun = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        log("started; \(settings.summary); designs in \(Designs.root.path)")
        logTarget()
        // Matching was switched off while this was not running (or it quit without restoring).
        if !settings.matchDesktop { desktop.restore(reason: "matching is off") }
        feed.setPeriod(settings.periodMs)
        feed.onLine = { [weak self] line in self?.push(line) }
        // The last state from before, so the first page load draws it (LastLine).
        if let saved = LastLine.read() {
            replay.note(saved.line)
            lastLineSavedT = saved.t
            log("state: read the last line from \(LastLine.file.path), \(Self.age(saved.t)), \(saved.line.utf8.count) bytes, with \(replay.held)")
        } else {
            log("state: no saved last line in \(LastLine.file.path); a page loaded before the feed's first line has nothing to draw")
        }
        // A test instance runs the wallpaper's own code paths beside the live one without touching
        // anything of it or of the screen: its own settings.json and pictures (TestHome), no
        // menu-bar item, no hotkeys, invisible windows below the desktop, the desktop picture only
        // logged, and covered only by SIGUSR2 (with KILNWALL_TEST_COVER=1, or =covered to launch
        // covered). Its design or appearance is switched by writing its settings.json, which takes
        // the menu's path from applySettings.
        if testInstance {
            forcedCover = ProcessInfo.processInfo.environment["KILNWALL_TEST_COVER"] == "covered"
            log("test: instance in \(TestHome.url!.path): no menu-bar item or hotkeys, invisible windows, desktop picture never set"
                + (forcedCover == true ? "; launched covered" : ""))
        } else {
            buildStatusItem()
            registerHotkeys()
        }
        watchPageFolder()
        settingsWatcher = SettingsWatcher { [weak self] in self?.settingsFileChanged() }
        watchSystem()
        dock.onChange = { [weak self] geometry, why in self?.dockChanged(geometry, why: why) }
        dock.start()
        syncWindows()
        refreshLowPower()
        apply()
    }

    // The Dock lengthened, shortened or moved: the pages re-lay out from their config (Kiln.onDock).
    private func dockChanged(_ geometry: [CGDirectDisplayID: DockInfo], why: String) {
        let text = geometry.isEmpty ? "on no display"
            : geometry.keys.sorted().map { "display \($0): \(geometry[$0]!.description)" }.joined(separator: "; ")
        log("dock: \(text) (\(why)); \(webViews.count) page(s) told")
        configureEverywhere()
    }

    func applicationWillTerminate(_ notification: Notification) {
        saveLastLine(why: "quit", now: true)
        feed.stop()
        desktop.enabled = false
        desktop.restore(reason: "quit")
        log("quit")
    }

    // MARK: Running and pausing

    private func set(_ reason: PauseReason, _ active: Bool) {
        let changed = active ? reasons.insert(reason).inserted : reasons.remove(reason) != nil
        guard changed else { return }
        if active { pausedFor.insert(reason) }
        log("\(active ? "+" : "-") \(reason.rawValue)")
        let wasRunning = running
        apply()
        // Already paused in view (by you, Low Power Mode) and now unseen as well: covered too.
        if active, !wasRunning, !running, Self.unseenReasons.contains(reason) {
            for display in webViews.keys { coverUnseen(display) }
        }
    }

    // The pauses in which nobody sees the window (the others leave the page in view, paused).
    private static let unseenReasons: Set<PauseReason> = [.covered, .locked, .hidden]

    // Only "desktop covered" alone gets the grace: locked, Low Power Mode, paused by you and
    // hidden stop the feed at once, also when one of them joins a cover already in its grace.
    private func apply() {
        let shouldRun = reasons.isEmpty
        if shouldRun != running {
            running = shouldRun
            if shouldRun {
                let kept = holding
                let away = Date().timeIntervalSince(pausedSince)
                runningSince = Date()
                endGrace()
                feed.setPeriod(settings.periodMs)
                feed.start()
                for display in Array(unseen.keys) { endUnseen(display, why: "running again") }
                if reloadOnRun {
                    // Changed while hidden (the only pause that cannot draw unseen): reload now,
                    // under the newest picture of the look it will show; a page still showing an
                    // older look gets that look's colour rather than staying in view.
                    reloadOnRun = false
                    log("page: reloading on return (changed while paused)")
                    for (display, webView) in webViews {
                        if let overlay = overlays[display], overlay.look != currentLook {
                            // The picture put up at the hide, of the look before the change.
                            coverWithCurrentLook(display, why: "reload on return")
                        } else if overlays[display] == nil, !showCurrentPicture(display, why: "reload on return"), showsOldLook(display) {
                            showSolid(display, why: "reload on return")
                        }
                        if overlays[display] != nil {
                            load(display, webView)
                        } else {
                            reload(display, webView)  // no picture yet: a snapshot of the page first
                        }
                    }
                } else {
                    // Past the grace, cover the return with a picture of the look the page shows
                    // until its first frames after resume (afterResume): WebKit may have dropped
                    // the pixels of a long-hidden page. Likewise a page that has not drawn its data
                    // or a new appearance. A page drawn unseen keeps the picture of that drawing.
                        let unseenAway = !pausedFor.isDisjoint(with: [.covered, .locked, .hidden])
                    for display in webViews.keys {
                        let returning = String(format: "return after %.0f s", away)
                        if let overlay = overlays[display] {
                            // Put up as the window went unseen (coverUnseen), or by a drawing unseen.
                            // Of an older look (an appearance changed while hidden): the current one's.
                            if overlay.look != currentLook, showCurrentPicture(display, why: returning + ", over a picture of \(overlay.look?.description ?? "?")") {
                            } else {
                                log("overlay: display \(display) keeps its picture over the \(returning), until the first frames after resume")
                            }
                        } else if away >= Self.coveredGrace {
                            showCurrentPicture(display, why: returning + ", past the grace")
                        } else if !painted.contains(display) {
                            showCurrentPicture(display, why: returning + " to a page that has not drawn its data")
                        } else if let want = wanted[display], drawn[display]?.gen != want.gen,
                                  (drawn[display]?.gen ?? -1) >= (loading[display]?.gen ?? 0) {
                            showCurrentPicture(display, why: "return to an appearance not drawn yet")
                        } else if unseenAway {
                            showCurrentPicture(display, why: returning + " unseen, with no picture up: WebKit may have emptied the hidden page")
                        } else {
                            log("overlay: display \(display) none for the \(returning), seen throughout (\(PauseReason.allCases.filter(pausedFor.contains).map(\.rawValue).joined(separator: ", "))): the page shows what it drew (\(drawn[display]?.look.description ?? "?"))")
                        }
                    }
                    // While the page is still paused, so its figures snap to the state instead of
                    // gliding from the old one; the feed's next line follows within one period. Kept
                    // past the grace, it is old: marked cached (stale) until the restarted feed's
                    // first line, ~1.3 s after its cold start.
                    if heldUnsent { sendLatest(why: kept ? "uncovered within the grace" : "running again", cached: !kept) }
                }
                evaluateEverywhere("window.kiln && window.kiln.resume && window.kiln.resume()")
                afterResume()
                for display in overlays.keys where overlayTimeouts[display] == nil { armOverlayTimeout(display) }
                log((kept ? "running (feed kept through the cover, \(feed.mode))" : "running") + String(format: " after %.1f s paused", away))
            } else {
                pausedSince = Date()
                runningSince = .distantFuture
                drawnSinceRun = []
                pausedFor = reasons
                pauses += 1
                saveLastLine(why: "paused")
                // Unseen from now: the window is covered with a picture of the page as it is
                // (coverUnseen), so the return shows that picture from its first frame.
                if !reasons.isDisjoint(with: Self.unseenReasons) {
                    for display in webViews.keys { coverUnseen(display) }
                }
                if reasons == [.covered] { startGrace() } else { feed.stop() }
                evaluateEverywhere("window.kiln && window.kiln.pause && window.kiln.pause()")
                log("paused: \(stateText)")
            }
        } else if holding, reasons != [.covered] {
            log("feed: grace cut short (\(stateText))")
            stopHeldFeed()
        }
        statusItem?.button?.appearsDisabled = !running
        menu?.refresh()
    }

    // The covered grace. The feed is told the slow period on its stdin (same pid, same state);
    // its lines only update `replay`.
    private func startGrace() {
        holding = true
        graceStarted = Date()
        feed.setPeriod(Self.coveredPeriodMs)
        graceCPU = feed.childPID.flatMap(Headless.cpuSeconds)
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.graceExpired() }
        }
        graceWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.coveredGrace, execute: work)
        log("feed: kept \(Int(Self.coveredGrace)) s under the cover at \(Self.coveredPeriodMs) ms, lines held (\(feed.mode))")
    }

    private func graceExpired() {
        graceWork = nil
        guard holding else { return }
        log("feed: grace over")
        stopHeldFeed()
    }

    private func stopHeldFeed() {
        let seconds = Date().timeIntervalSince(graceStarted)
        if let before = graceCPU, let pid = feed.childPID, let after = Headless.cpuSeconds(pid) {
            log(String(format: "feed: kiln-feed.py (pid %d) used %.0f ms CPU in %.0f s held at %d ms, %.2f%% of a core",
                       pid, (after - before) * 1000, seconds, Self.coveredPeriodMs, (after - before) / seconds * 100))
        }
        endGrace()
        feed.stop()
        feed.setPeriod(settings.periodMs)  // no child now: what the next one starts with
        saveLastLine(why: "feed stopped")
    }

    // LastLine: the merged latest state to disk, if it is newer than what was written.
    private func saveLastLine(why: String?, now: Bool = false) {
        lastLineSaved = Date()
        guard let latest = replay.latest(), let t = latest.t, t != lastLineSavedT else { return }
        lastLineSavedT = t
        LastLine.write(latest.line, now: now) { problem in
            log("state: cannot write \(LastLine.file.path): \(problem)")
        }
        if let why {
            log("state: saving the last line (\(why)), \(Self.age(t)), \(latest.line.utf8.count) bytes, with \(replay.held)")
        }
    }

    private func endGrace() {
        graceWork?.cancel()
        graceWork = nil
        holding = false
        graceCPU = nil
    }

    private var stateText: String {
        if reasons.isEmpty { return "Running" }
        return "Paused: " + PauseReason.allCases.filter(reasons.contains).map(\.rawValue).joined(separator: ", ")
    }

    // MARK: Design and period

    // Applies only what changed. Every writer of settings.json lands here: this app's menu and
    // hotkeys apply first and then write the file, so the watcher's re-read finds nothing new.
    private func applySettings(_ new: Settings, source: String) {
        let old = settings
        guard new != old else { return }
        settings = new
        if new.periodMs != old.periodMs {
            log("period \(old.periodMs) -> \(new.periodMs) ms (\(source))")
            // Held under a cover, the feed stays slow; uncovering restores settings.periodMs.
            if !holding { feed.setPeriod(new.periodMs) }
        }
        if new.tempUnit != old.tempUnit {
            log("temperature unit °\(old.tempUnit.rawValue) -> °\(new.tempUnit.rawValue) (\(source))")
        }
        let appearanceChanged = new.appearance != old.appearance
        if appearanceChanged {
            log("appearance \(old.appearance.rawValue) -> \(new.appearance.rawValue) (\(source))")
        }
        // A new design reloads the page, and the load schedules the desktop picture's update.
        if new.design != old.design {
            log("design \(old.design) -> \(new.design) (\(source))")
            retarget()
        }
        if new.matchDesktop != old.matchDesktop {
            log("match desktop \(old.matchDesktop) -> \(new.matchDesktop) (\(source))")
            desktop.enabled = new.matchDesktop
            if new.matchDesktop {
                snapshotEverywhere(reason: "matching switched on", force: true)
            } else {
                desktop.restore(reason: "matching switched off")
            }
        }
        // Appearance and unit apply live: the runtime re-renders on config (Kiln.onPrefs), no reload.
        configureEverywhere()
        if appearanceChanged { appearanceSent() }
        menu?.refresh()
    }

    // A choice made here: apply, then record it in settings.json.
    private func choose(_ new: Settings, source: String) {
        if new == settings {
            log("\(source): already \(new.summary)")
            return
        }
        applySettings(new, source: source)
        do {
            try new.write()
        } catch {
            log("settings: cannot write \(Settings.file.path): \(error.localizedDescription)")
        }
    }

    private func settingsFileChanged() {
        guard let read = Settings.reread(over: settings) else {
            log("settings: \(Settings.file.path) missing or unreadable; keeping design \(settings.design), period \(settings.periodMs) ms")
            return
        }
        applySettings(read, source: "settings file")
    }

    // The hotkeys, the menu's slider and its tortoise and hare all set the period here.
    private func setPeriod(_ ms: Int, source: String) {
        var next = settings
        next.periodMs = Settings.clamp(ms)
        choose(next, source: source)
    }

    private func stepPeriod(_ delta: Int, source: String) {
        setPeriod(settings.periodMs + delta, source: source)
    }

    // ⌃⌥= faster (−100 ms), ⌃⌥- slower (+100 ms): like btop, "+" is faster.
    private func registerHotkeys() {
        let chord = controlKey | optionKey
        let faster = hotkeys.register(keyCode: kVK_ANSI_Equal, modifiers: chord) { [weak self] in
            self?.stepPeriod(-Settings.step, source: "hotkey")
        }
        let slower = hotkeys.register(keyCode: kVK_ANSI_Minus, modifiers: chord) { [weak self] in
            self?.stepPeriod(Settings.step, source: "hotkey")
        }
        func result(_ status: OSStatus) -> String { status == noErr ? "registered" : "FAILED (OSStatus \(status))" }
        log("hotkeys: ⌃⌥= (faster) \(result(faster)); ⌃⌥- (slower) \(result(slower))")
    }

    // Re-resolves the page; loads it everywhere if it is a different one.
    private func retarget() {
        let next = PageTarget.resolve(settings.design)
        guard next != target else { return }
        target = next
        logTarget()
        watchPageFolder()
        lookChanged("design \(currentLook.design)")
        reloadPages(newLook: true)
    }

    // MARK: Looks: which design and appearance a picture shows

    // The design (or "_page" for a page that is not a design) and appearance the page is told now.
    private var currentLook: Look {
        Look(design: target.design ?? "_page", appearance: settings.appearance.rawValue)
    }

    private func pageShowsCurrent(_ display: CGDirectDisplayID) -> Bool {
        guard let want = wanted[display], let have = drawn[display] else { return false }
        return want.gen == have.gen
    }

    // The page on screen is of a look other than the one chosen (it has not drawn the new one).
    private func showsOldLook(_ display: CGDirectDisplayID) -> Bool {
        guard let have = drawn[display] else { return false }
        return have.look != currentLook
    }

    // The newest picture of what the page is to show. Pictures are tagged light or dark, as drawn
    // (Desktop.swift); a forced appearance is its own; "auto" is the look this page was last seen
    // to draw it in (autoDrawn), and before it has been seen, the design's newest picture in
    // either look. `how` says which, for the logs.
    private func matchingPicture(_ display: CGDirectDisplayID) -> (picture: DesktopPicture?, how: String) {
        let choice = currentLook
        guard choice.isAuto else {
            return (DesktopMatcher.newestPicture(display, of: choice), "a picture of \(choice)")
        }
        if let seen = autoDrawn[display], seen.design == choice.design {
            return (DesktopMatcher.newestPicture(display, of: seen), "\(choice) as drawn here: a picture of \(seen)")
        }
        let newest = DesktopMatcher.newestPicture(display, design: choice.design)
        return (newest, "\(choice), not yet seen drawn here: the newest picture of \(choice.design)"
            + (newest?.look.map { " (\($0.appearance))" } ?? ""))
    }

    // A new design or appearance. Nothing of the old look may stand in for the new one from here:
    // every snapshot of the old page under way is dropped (`wanted` moves on); the desktop picture
    // becomes the newest picture of the new look, else a plain field of its background colour, at
    // once; and the new look's first drawing is snapshotted as soon as it is on screen, past the
    // 60 s throttle (freshDue), which sets the desktop picture to it.
    private func lookChanged(_ why: String) {
        let look = currentLook
        for display in webViews.keys {
            generation += 1
            wanted[display] = (generation, look)
            freshDue.insert(display)
            guard settings.matchDesktop else { continue }
            let match = matchingPicture(display)
            if let picture = match.picture {
                desktop.setPicture(display, picture, reason: "\(why), until it is drawn; \(match.how)")
            } else {
                let background = DesignBackgrounds.colour(for: look)
                desktop.setSolid(display, background.colour, look: look, reason: "\(why), until it is drawn; \(background.source)") {
                    [weak self] in self?.currentLook == look
                }
            }
        }
    }

    // The page has been sent a new appearance (configureEverywhere); it re-renders itself.
    private func appearanceSent() {
        lookChanged("appearance \(settings.appearance.rawValue)")
        for (display, webView) in webViews {
            guard let want = wanted[display] else { continue }
            if webView.isLoading || (drawn[display]?.gen ?? -1) < (loading[display]?.gen ?? 0) {
                // Still loading: its own {painted} comes after its config, which carries this.
                loading[display] = want
            } else if running, isShown(display) {
                settleThenDrawn(display, webView, gen: want.gen)
            } else if !reasons.contains(.hidden) {
                // It has drawn its data (else it is still in the branch above): it re-renders that.
                renderUnseen(display, webView, .reconfigured, why: "new appearance while paused")
            }
            // Hidden: drawn after the first frames once it is shown again (afterResume).
        }
    }

    // Two frames and the designs' colour transitions after a config: the page shows `gen`.
    private func settleThenDrawn(_ display: CGDirectDisplayID, _ webView: WKWebView, gen: Int) {
        afterFrames(webView, display) { [weak self] in
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.appearanceSettle) {
                MainActor.assumeIsolated {
                    guard let self, self.webViews[display] === webView, let want = self.wanted[display], want.gen == gen
                    else { return }
                    // Re-rendered, but of what? Only a page with data counts as showing the look.
                    guard self.painted.contains(display) else {
                        return log("page on display \(display) re-rendered for \(want.look) but has drawn no data: not counted as drawn")
                    }
                    self.drawn[display] = want
                    log(String(format: "page on display %u shows %@ (two frames and %.1f s after its config)",
                               display, want.look.description, Self.appearanceSettle))
                    self.readBackground(display, webView, look: want.look)
                    if self.running {
                        self.drawnSinceRun.insert(display)
                        self.snapshotIfDue(display, reason: "new appearance drawn")
                    } else if self.unseen[display] != nil {
                        self.unseenDrawn(display)
                    }
                }
            }
        }
    }

    // `body` once the page has drawn two frames from now; never if it navigates meanwhile or is
    // not drawing (a page WebKit counts unseen gets no frames).
    private func afterFrames(_ webView: WKWebView, _ display: CGDirectDisplayID, _ body: @escaping () -> Void) {
        webView.callAsyncJavaScript(
            "await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
            arguments: [:], in: nil, in: .page
        ) { [weak self] result in
            guard let self, self.webViews[display] === webView, case .success = result else { return }
            body()
        }
    }

    // Only of a page that has drawn data, and showing the look it is meant to. An "auto"
    // snapshot also tells which look auto is drawn in here (autoDrawn).
    private func requestSnapshot(_ display: CGDirectDisplayID, reason: String, completion: @escaping (URL?) -> Void = { _ in }) {
        guard let want = wanted[display], painted.contains(display) else { return completion(nil) }
        desktop.update(display, .init(reason: reason, look: want.look, isCurrent: { [weak self] in
            guard let self else { return false }
            return self.wanted[display]?.gen == want.gen && self.drawn[display]?.gen == want.gen && self.painted.contains(display)
        }, completion: { [weak self] url in
            if let self, let url, want.look.isAuto,
               let shown = DesktopPicture(url.lastPathComponent, display: display, in: DesktopMatcher.folder)?.look {
                if self.autoDrawn[display] != shown { log("look: display \(display) draws \(want.look) as \(shown.appearance) (\(url.lastPathComponent))") }
                self.autoDrawn[display] = shown
            }
            completion(url)
        }))
    }

    // MARK: Drawing a new look unseen

    // A design switch or an appearance change while the wallpaper is paused with its windows in
    // (covered, locked, Low Power Mode, paused by you): the page is loaded or re-rendered and
    // drawn NOW, so the desktop picture shows the new look before the user is back on the desktop and
    // the window holds it from the first frame of the return. cc3a2b8 deferred these to the
    // return, which showed the old design there for a second or so: in the Space animation (the
    // desktop picture) and in the window until the reload painted. WebKit does not draw a page it
    // counts unseen, so its occlusion check is off for this page until the snapshot is written,
    // at most unseenTimeout. The new look's picture or colour covers the window meanwhile, in
    // case the return comes first.
    // The same goes for an edit to the shown design's files (cc3a2b8 deferred that reload to the
    // return too: at 12:31 on 2026-11-05 the return reloaded the page, the worst moment), and for
    // any page that finishes loading while paused: the launch under a cover, a WebContent restart
    // (beginUnseen from didFinish). Each such load is first sent the saved last state (LastLine),
    // so it has a full line to draw with no feed running; before that state was kept, a launch
    // under a cover was "not drawn within 10 s".
    private enum UnseenDraw {
        case reload        // a new design or changed page files: load it
        case reconfigured  // a new appearance: the page re-renders on its config
    }

    private func renderUnseen(_ display: CGDirectDisplayID, _ webView: WKWebView, _ draw: UnseenDraw, why: String) {
        coverWithCurrentLook(display, why: why)
        beginUnseen(display, why: why)
        switch draw {
        case .reload: load(display, webView)
        case .reconfigured: if let want = wanted[display] { settleThenDrawn(display, webView, gen: want.gen) }
        }
    }

    private func beginUnseen(_ display: CGDirectDisplayID, why: String) {
        unseen[display]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.endUnseen(display, why: "not drawn within \(Int(Self.unseenTimeout)) s") }
        }
        unseen[display] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.unseenTimeout, execute: work)
        applyOcclusionDetection(display)
        log("page: drawing \(currentLook) unseen on display \(display) (\(why); \(stateText))")
    }

    // Drawn unseen: snapshotted, which sets the desktop picture, and that picture becomes the
    // window's cover until the first frames after the return (afterResume), so the return shows
    // this drawing even if WebKit has dropped the hidden page's pixels by then.
    private func unseenDrawn(_ display: CGDirectDisplayID) {
        freshDue.remove(display)
        let look = currentLook
        requestSnapshot(display, reason: "drawn unseen") { [weak self] url in
            guard let self else { return }
            if let url, !self.running, let image = NSImage(contentsOf: url) {
                self.showOverlay(display, image, look: look, from: "\(url.lastPathComponent) (drawn unseen, with data)")
            }
            if url == nil { self.freshDue.insert(display) }
            self.endUnseen(display, why: url == nil ? "no snapshot" : "snapshot written")
        }
    }

    private func endUnseen(_ display: CGDirectDisplayID, why: String) {
        guard let work = unseen.removeValue(forKey: display) else { return }
        work.cancel()
        applyOcclusionDetection(display)
        log("page: unseen drawing on display \(display) ended (\(why))")
    }

    // WebKit's occlusion check stays on (a covered page draws nothing), except while drawing a
    // new look unseen, and in a test instance whose invisible window stands in for a shown one.
    // WebKit reads the check only when the window's occlusion changes, so the change is posted:
    // measured 2026-11-05 on a test instance, a design switched under a cover with the check
    // merely turned off was "not drawn within 10 s", as with it left on (the control); with this
    // post it painted 0.11 s after the switch.
    fileprivate func applyOcclusionDetection(_ display: CGDirectDisplayID) {
        guard let webView = webViews[display] else { return }
        let on = unseen[display] == nil && !(testInstance && forcedCover == false)
        if !Self.setOcclusionDetection(webView, on) { log("page: cannot turn WebKit's occlusion check \(on ? "on" : "off")") }
        if let window = windows[display] {
            NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: window)
        }
    }

    // Private WKWebView API (-_setWindowOcclusionDetectionEnabled:, in WebKit since 2017): with it
    // off, WebKit counts the view visible whenever its window is ordered in. True if it took.
    @discardableResult
    static func setOcclusionDetection(_ webView: WKWebView, _ on: Bool) -> Bool {
        let setter = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        guard webView.responds(to: setter) else { return false }
        typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
        unsafeBitCast(webView.method(for: setter), to: SetBool.self)(webView, setter, on)
        return (webView.value(forKey: "_windowOcclusionDetectionEnabled") as? NSNumber)?.boolValue == on
    }

    // Test instance with KILNWALL_TEST_SHOTS=<folder>: what the window shows, as PNGs there, each
    // logged with its luma over 48x30 (as the pictures are scored). Never the screen: the window's
    // own views and the web view's own snapshot. Per moment, <n>-<moment>-display<d>-cache.png is
    // the content view by cacheDisplay (the overlay, and the web view's presented layers, as
    // AppKit draws them), -webview.png the web view alone by cacheDisplay (what WebKit presents
    // under the overlay), and -window.png the window's background colour, the page's snapshot over
    // it (what the page has drawn, rendered afresh by WebKit) and the overlay's picture on top
    // when one is up.
    fileprivate func testShot(_ display: CGDirectDisplayID, _ moment: String, overlay: NSImage?) {
        guard let folder = Self.testShots, let window = windows[display], let container = window.contentView,
              let webView = webViews[display] else { return }
        shotCount += 1
        let base = String(format: "%02d-%@-display%u", shotCount, moment, display)
        // The content view as drawn, and the web view alone: what WebKit presents under the overlay.
        for (view, suffix, note) in [(container, "-cache.png", "content view by cacheDisplay"),
                                     (webView as NSView, "-webview.png", "web view alone by cacheDisplay")] {
            guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { continue }
            view.cacheDisplay(in: view.bounds, to: rep)
            if let image = rep.cgImage { Self.writeShot(image, folder.appendingPathComponent(base + suffix), note: note) }
        }
        let scale = window.backingScaleFactor
        let width = Int((container.bounds.width * scale).rounded()), height = Int((container.bounds.height * scale).rounded())
        let background = window.backgroundColor.usingColorSpace(.sRGB)?.cgColor ?? CGColor(gray: 0, alpha: 1)
        let picture = overlay?.cgImage(forProposedRect: nil, context: nil, hints: nil)
        let configuration = WKSnapshotConfiguration()
        configuration.afterScreenUpdates = false
        webView.takeSnapshot(with: configuration) { page, error in
            MainActor.assumeIsolated {
                guard let space = CGColorSpace(name: CGColorSpace.sRGB),
                      let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
                else { return }
                let rect = CGRect(x: 0, y: 0, width: width, height: height)
                context.setFillColor(background)
                context.fill(rect)
                if let page = page?.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                    context.draw(page, in: rect)
                } else {
                    log("test: \(base) page snapshot failed: \(error?.localizedDescription ?? "no image")")
                }
                if let picture { context.draw(picture, in: rect) }
                guard let image = context.makeImage() else { return }
                Self.writeShot(image, folder.appendingPathComponent(base + "-window.png"),
                               note: picture == nil ? "window background + page" : "window background + page + overlay")
            }
        }
    }

    private static func writeShot(_ image: CGImage, _ url: URL, note: String) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var written = false
        if let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) {
            CGImageDestinationAddImage(destination, image, nil)
            written = CGImageDestinationFinalize(destination)
        }
        let stats = DesktopMatcher.lumaStats(image).map { String(format: "luma mean %.1f std %.1f", $0.mean, $0.std) } ?? "luma unknown"
        log("test: shot \(url.lastPathComponent) (\(note)): \(written ? stats : "NOT written")")
    }

    // Whether the window is on screen: the window server's word, or in a test instance the forced cover.
    private func isShown(_ display: CGDirectDisplayID) -> Bool {
        if testInstance { return forcedCover != true }
        return windows[display]?.occlusionState.contains(.visible) == true
    }

    private func logTarget() {
        if target.design == settings.design {
            log("page: \(target.label), \(target.index.path)")
        } else {
            log("page: design \(settings.design) has no index.html in \(Designs.root.path); showing \(target.label) (\(target.index.path))")
        }
    }

    // What the page is told: the design it is (the chosen one, or the fallback actually shown),
    // and the Dock on its display (null: not on this one).
    private func pageConfig(_ display: CGDirectDisplayID) -> [String: Any] {
        ["design": target.design ?? settings.design, "period_ms": settings.periodMs,
         "appearance": settings.appearance.rawValue, "temp_unit": settings.tempUnit.rawValue,
         "dock": dock.current[display]?.page ?? NSNull()]
    }

    private func configureEverywhere() {
        for webView in webViews.values { configure(webView) }
    }

    private func configure(_ webView: WKWebView) {
        let display = webViews.first { $0.value === webView }?.key ?? 0
        Self.configure(webView, pageConfig(display)) { [weak self] error in self?.scriptFailed(error) }
    }

    // MARK: Page

    // The next four are shared with the headless modes (Headless.swift), so a snapshot loads and
    // feeds the page exactly as the wallpaper does.
    static func makeWebView(size: NSSize, messages: WKScriptMessageHandler) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(messages, name: "kiln")
        let webView = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        // Let the window's background show until the page paints, instead of WebKit's white.
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .black
        return webView
    }

    // A design reads the whole designs folder (its pages load ../_shared/kiln-runtime.js).
    // WebKit's memory cache is emptied first: a loadFileURL into the same web view otherwise
    // serves the page's scripts from it, so the new index.html ran the OLD panes.js, deck.js, ...
    // and no design JS edit reached the wallpaper from 00:58 to 02:15 on 2026-11-05 (found by the
    // Glass agent; reload() or this removal both load the new file).
    static func loadPage(_ webView: WKWebView, _ target: PageTarget) {
        webView.configuration.websiteDataStore.removeData(
            ofTypes: [WKWebsiteDataTypeMemoryCache], modifiedSince: .distantPast
        ) { [weak webView] in
            webView?.loadFileURL(target.index, allowingReadAccessTo: target.readAccess)
        }
    }

    // Data for the page: the line's raw text as a String argument (no string building), which the
    // runtime JSON.parses. Measured 2026-11-04 at 100 ms on a page that draws nothing, against
    // parsing it here and bridging the nested object: host 1.0% -> 0.7% of a core, WebContent
    // 0.8% -> 0.5%. (On glass the host stays ~3%: that is WebKit serving the page's frames.)
    static func send(_ line: String, to webView: WKWebView, onError: @escaping (Error) -> Void) {
        webView.callAsyncJavaScript(
            "window.kiln && window.kiln.update(line)", arguments: ["line": line], in: nil, in: .page
        ) { result in
            if case .failure(let error) = result { onError(error) }
        }
    }

    // {design, period_ms, appearance, temp_unit, dock} for the page: after every load and on every change.
    static func configure(_ webView: WKWebView, _ config: [String: Any], onError: @escaping (Error) -> Void) {
        webView.callAsyncJavaScript(
            "window.kiln && window.kiln.config && window.kiln.config(c)", arguments: ["c": config], in: nil, in: .page
        ) { result in
            if case .failure(let error) = result { onError(error) }
        }
    }

    private func load(_ display: CGDirectDisplayID, _ webView: WKWebView) {
        generation += 1
        loading[display] = (generation, currentLook)
        wanted[display] = loading[display]
        painted.remove(display)
        Self.loadPage(webView, target)
    }

    // The designs folder, recursively (a new design, or the chosen one gaining its index.html,
    // retargets), plus the old page folder while that is what is shown.
    private func watchPageFolder() {
        var folders = [Designs.root]
        if target.design == nil { folders.append(target.readAccess) }
        watcher = FolderWatcher(folders) { [weak self] paths in self?.pageFilesChanged(paths) }
    }

    // Editors save in bursts (temp file, rename, attributes): one reload per burst. Only a change
    // to the page being shown (its design folder or _shared) reloads it; the other designs'
    // folders change all the time while they are worked on.
    private func pageFilesChanged(_ paths: [String]) {
        changedPaths += paths
        reloadWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.pageFilesSettled() }
        }
        reloadWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.reloadDebounce, execute: work)
    }

    private func pageFilesSettled() {
        reloadWork = nil
        let paths = changedPaths
        changedPaths = []
        let before = target
        retarget()
        if target != before { return }
        if let changed = paths.first(where: touchesTarget) {
            log("page files changed (\(changed)); reloading")
            reloadPages()
        }
    }

    private func touchesTarget(_ path: String) -> Bool {
        let shown = canonicalPath(target.index.deletingLastPathComponent())
        let shared = canonicalPath(Designs.root.appendingPathComponent("_shared", isDirectory: true))
        return [shown, shared].contains { path == $0 || path.hasPrefix($0 + "/") }
    }

    // A reload this app decides on (a design file changed, a design switch, the menu's Reload): a
    // snapshot of the page as it is goes over it first, so the reload never shows blank; for a
    // new design, a picture of the new one (or its colour), never the old. While paused, the
    // reload is drawn now, unseen (renderUnseen), seeded with the last state, so the return
    // reloads nothing; only while hidden (no window to draw in) does it wait for the return.
    private func reloadPages(newLook: Bool = false) {
        guard running else {
            if !reasons.contains(.hidden) {
                reloadOnRun = false  // this load reads every file afresh
                let why = newLook ? "new design while paused" : "page files changed while paused"
                for (display, webView) in webViews { renderUnseen(display, webView, .reload, why: why) }
                return
            }
            if !reloadOnRun { log("page: reload deferred until the wallpaper runs (\(stateText))") }
            reloadOnRun = true
            return
        }
        for (display, webView) in webViews { reload(display, webView) }
    }

    private func reload(_ display: CGDirectDisplayID, _ webView: WKWebView) {
        // A new design: its own picture or colour over the old page, not a snapshot of the old.
        if showsOldLook(display) {
            coverWithCurrentLook(display, why: "new design")
            return load(display, webView)
        }
        // Still covering a load that has not painted: that picture is the right one, not a new
        // snapshot of a half-loaded page.
        if overlays[display] != nil {
            armOverlayTimeout(display)
            return load(display, webView)
        }
        // Only a page on screen that has drawn data is snapshotted; otherwise the newest picture of
        // its look. (A snapshot of a page with no data is an empty layout, which passed the blank
        // check at luma std 5.4 at 12:31 on 2026-11-05.)
        guard isShown(display), painted.contains(display) else {
            showCurrentPicture(display, why: painted.contains(display) ? "reload of a page not on screen" : "reload of a page that has drawn no data")
            return load(display, webView)
        }
        // A snapshot already under way loads the page (the current target) when it completes.
        guard snapshotting.insert(display).inserted else { return }
        let started = DispatchTime.now().uptimeNanoseconds
        let configuration = WKSnapshotConfiguration()
        configuration.afterScreenUpdates = false  // what is on screen now, also while paused
        webView.takeSnapshot(with: configuration) { [weak self] image, error in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.snapshotting.remove(display)
                guard self.webViews[display] === webView else { return }
                let ms = Double(DispatchTime.now().uptimeNanoseconds - started) / 1e6
                if let image, self.showOverlay(display, image, look: self.drawn[display]?.look,
                                               from: String(format: "a snapshot of the running page (%.0f ms)", ms)) {
                } else {
                    if image == nil { log("overlay: display \(display) snapshot failed: \(error?.localizedDescription ?? "no image")") }
                    self.showCurrentPicture(display, why: "reload")
                }
                self.load(display, webView)
            }
        }
    }

    private func push(_ line: String) {
        replay.note(line)
        if Date().timeIntervalSince(lastLineSaved) >= LastLine.every { saveLastLine(why: nil) }
        if holding {
            heldUnsent = true
            return
        }
        heldUnsent = false
        for (display, webView) in webViews {
            Self.send(line, to: webView) { [weak self] error in self?.scriptFailed(error) }
            if running {
                sentSinceSnapshot.insert(display)
                snapshotIfDue(display, reason: "running")
            }
        }
        if running { menu?.beat() }
    }

    // The latest state (the last line with every held block) as one normal line: the page renders
    // it at once, at the time it carries.
    private func sendLatest(why: String, cached: Bool = false) {
        heldUnsent = false
        guard let latest = replay.latest(cached: cached) else { return }
        for webView in webViews.values {
            Self.send(latest.line, to: webView) { [weak self] error in self?.scriptFailed(error) }
        }
        log("page: sent the latest state (\(why))\(cached ? ", marked cached" : ""), \(Self.age(latest.t)), \(latest.line.utf8.count) bytes")
    }

    private static func age(_ t: Double?) -> String {
        guard let t else { return "blocks only (no full line yet)" }
        return String(format: "%.1f s old", Date().timeIntervalSince1970 - t)
    }

    private func evaluateEverywhere(_ body: String) {
        for webView in webViews.values {
            webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { [weak self] result in
                if case .failure(let error) = result { self?.scriptFailed(error) }
            }
        }
    }

    // A broken page would otherwise log once a second. WebKit's description is only "A JavaScript
    // exception occurred"; the message, file and line are in the error's userInfo.
    private func scriptFailed(_ error: Error) {
        scriptErrors += 1
        if scriptErrors <= 3 || scriptErrors % 60 == 0 {
            let info = (error as NSError).userInfo
            let message = info["WKJavaScriptExceptionMessage"].map { ": \($0)" } ?? ""
            let file = (info["WKJavaScriptExceptionSourceURL"] as? URL).map {
                " (\($0.deletingLastPathComponent().lastPathComponent)/\($0.lastPathComponent)"
                    + (info["WKJavaScriptExceptionLineNumber"].map { " line \($0)" } ?? "") + ")"
            } ?? ""
            log("page script error #\(scriptErrors)\(message)\(file) [\(target.label)]")
        }
    }

    // window.webkit.messageHandlers.kiln.postMessage(...) from the page: logged as proof of delivery.
    fileprivate func pageSaid(_ message: WKScriptMessage) {
        acknowledged += 1
        let display = webViews.first { $0.value === message.webView }?.key ?? 0
        // kiln-runtime.js: the first line is on screen (two frames after it), once per load.
        if let body = message.body as? [String: Any], (body["painted"] as? Bool) == true {
            // Only from the page being shown: a {painted} still on its way from the page a switch
            // replaced must not lift the cover or label a picture.
            if let from = message.frameInfo.request.url, from.isFileURL, canonicalPath(from) != canonicalPath(target.index) {
                return log("page painted on display \(display): ignored, from \(from.path), not \(target.label)")
            }
            guard let load = loading[display] else { return }
            drawn[display] = load
            painted.insert(display)  // {painted} follows only a full line (kiln-runtime.js)
            log("page painted on display \(display): \(load.look), with data\(running ? "" : " (\(stateText))")")
            captureMark(display, "page painted")
            if running {
                drawnSinceRun.insert(display)
                fadeOverlay(display, why: "page painted")
                snapshotIfDue(display, reason: "page painted")
            } else if unseen[display] != nil {
                unseenDrawn(display)  // the cover stays until the return
            } else if reasons.isDisjoint(with: Self.unseenReasons) {
                fadeOverlay(display, why: "page painted")  // paused, but in view
            } else {
                log("overlay: display \(display) kept: the page painted unseen (\(stateText)); it goes after the first frames of the return")
            }
            return
        }
        // kiln-runtime.js echoes the Dock it now holds (Kiln.dock) whenever that changes.
        if let body = message.body as? [String: Any], let dock = body["dock"] {
            let text = (try? JSONSerialization.data(withJSONObject: ["dock": dock], options: [.sortedKeys]))
                .map { String(decoding: $0, as: UTF8.self) } ?? "\(dock)"
            return log("page on display \(display) has \(text)")
        }
        guard acknowledged == 1 || acknowledged % 10 == 0 else { return }
        let body = (try? JSONSerialization.data(withJSONObject: message.body))
            .map { String(decoding: $0, as: UTF8.self) } ?? "\(message.body)"
        log("page ack #\(acknowledged) on display \(display): \(body)")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let display = webViews.first { $0.value === webView }?.key ?? 0
        log("page loaded on display \(display) (WebContent pid \(Self.webProcessID(webView)))")
        scriptErrors = 0
        configure(webView)
        if !running {
            webView.callAsyncJavaScript(
                "window.kiln && window.kiln.pause && window.kiln.pause()", arguments: [:], in: nil, in: .page)
        }
        // The whole latest state as the page's first line, right after its config, so it draws at
        // once (and posts {painted: true}) instead of waiting for the feed's next line, or for an
        // uncover: the feed's, or before its first line the one saved on disk (LastLine). Marked
        // cached: kiln-runtime.js renders it in full and marks the page stale until a live line.
        let latest = replay.latest(cached: true)
        if let latest {
            log("page: sent the last state on load, marked cached, \(Self.age(latest.t)), with \(replay.held)")
            Self.send(latest.line, to: webView) { [weak self] error in self?.scriptFailed(error) }
        } else {
            log("page: no state to send on load (no saved line, no feed line yet): it draws nothing until the feed's first line")
        }
        if let look = loading[display]?.look { readBackground(display, webView, look: look) }
        scheduleDesktopAfterLoad(display)
        // Loaded while paused (a launch under a cover, a WebContent restart): drawn now, unseen,
        // so the window holds that drawing, and a picture of it, before the return.
        if !running, !reasons.contains(.hidden), unseen[display] == nil, latest?.t != nil, windows[display] != nil {
            beginUnseen(display, why: "loaded while paused")
        }
    }

    // The window shows its background wherever the page has not drawn (before its first paint,
    // during a WebContent restart): the page's own colour, not black. Kept per look
    // (DesignBackgrounds) for the window and the solid picture of a look with no picture yet.
    private func readBackground(_ display: CGDirectDisplayID, _ webView: WKWebView, look: Look) {
        let script = """
            const css = (e) => e ? getComputedStyle(e).backgroundColor : "";
            return [css(document.body), css(document.documentElement)];
            """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self, case .success(let value) = result, let colours = value as? [String] else { return }
            guard let css = colours.first(where: { Self.opaqueColour($0) != nil }), let colour = Self.opaqueColour(css),
                  self.currentLook == look else { return }
            DesignBackgrounds.learn(css, for: look)
            guard let window = self.windows[display], window.backgroundColor != colour else { return }
            window.backgroundColor = colour
            log("window background on display \(display): \(css) from the page (\(look))")
        }
    }

    // "rgb(11, 17, 32)" or "rgba(r, g, b, a)" with a > 0.
    static func opaqueColour(_ css: String) -> NSColor? {
        guard let open = css.firstIndex(of: "("), let close = css.lastIndex(of: ")") else { return nil }
        let parts = css[css.index(after: open)..<close].split(separator: ",").compactMap {
            Double($0.trimmingCharacters(in: .whitespaces))
        }
        guard parts.count >= 3, parts.count == 4 ? parts[3] > 0 : true else { return nil }
        return NSColor(srgbRed: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255, alpha: 1)
    }

    // MARK: Overlay over a reloading or returning page

    // Every picture is checked before it is shown: its luma over a 48x30 grid, logged, and refused
    // when it is a uniform field (a blank page), unless it is meant to be one (showSolid). A
    // populated page has a std of ~20 (glass). Every use is logged with the look it shows.
    @discardableResult
    private func showOverlay(_ display: CGDirectDisplayID, _ image: NSImage, look: Look?, from source: String,
                             solid: Bool = false) -> Bool {
        guard let container = windows[display]?.contentView else { return false }
        let what = look.map { "design \($0.design), appearance \($0.appearance)" } ?? "look unknown"
        var described = "a solid"
        if !solid {
            let stats = image.cgImage(forProposedRect: nil, context: nil, hints: nil).flatMap(DesktopMatcher.lumaStats)
            described = stats.map { String(format: "luma mean %.1f std %.1f", $0.mean, $0.std) } ?? "luma unknown"
            guard let stats, stats.std >= DesktopMatcher.blankLumaStd else {
                log("overlay: display \(display) refused \(source) (\(what)): blank (\(described))")
                return false
            }
        }
        let view = overlays[display]?.view ?? NSImageView(frame: container.bounds)
        view.image = image
        view.imageScaling = .scaleAxesIndependently
        view.autoresizingMask = [.width, .height]
        view.wantsLayer = true
        view.alphaValue = 1
        if view.superview == nil { container.addSubview(view, positioned: .above, relativeTo: nil) }
        overlays[display] = (view, Date(), look)
        captureMark(display, "overlay up")
        armOverlayTimeout(display)
        log("overlay: display \(display) shows \(what): \(source), \(described), until the page paints")
        return true
    }

    // The newest snapshot of the look the page is to show (written by DesktopMatcher, see
    // snapshotIfDue); never one of another design or appearance.
    @discardableResult
    private func showCurrentPicture(_ display: CGDirectDisplayID, why: String) -> Bool {
        let look = currentLook
        let match = matchingPicture(display)
        guard let picture = match.picture, let image = NSImage(contentsOf: picture.url) else {
            log("overlay: display \(display) has no picture to show (\(why)); wanted \(match.how)")
            return false
        }
        let age = Double(Int(Date().timeIntervalSince1970 * 1000) - picture.ms) / 1000
        return showOverlay(display, image, look: look, from: String(format: "%@, %.0f s old, %@ (%@)",
                                                                    picture.url.lastPathComponent, age, match.how, why))
    }

    // No picture of the look yet: a plain field of its background colour over a page that still
    // shows an older look.
    private func showSolid(_ display: CGDirectDisplayID, why: String) {
        let look = currentLook
        let background = DesignBackgrounds.colour(for: look)
        let image = NSImage(size: NSSize(width: 8, height: 8), flipped: false) { rect in
            background.colour.setFill()
            rect.fill()
            return true
        }
        showOverlay(display, image, look: look, from: "its background, \(background.source) (\(why))", solid: true)
    }

    // The window's cover until the page has drawn the current look.
    private func coverWithCurrentLook(_ display: CGDirectDisplayID, why: String) {
        if let overlay = overlays[display], overlay.look == currentLook { return armOverlayTimeout(display) }
        if !showCurrentPicture(display, why: why) { showSolid(display, why: why) }
    }

    // After resume(): the page's first two frames. Then the overlay goes (a page held by a cover
    // has posted {painted} long ago, so the host waits on the frames itself), an appearance set
    // while hidden is drawn, and a fresh snapshot still due is taken.
    private func afterResume() {
        for (display, webView) in webViews {
            afterFrames(webView, display) { [weak self] in
                guard let self, self.running else { return }
                // A page still loading has its own {painted} to wait for.
                guard !webView.isLoading, (self.drawn[display]?.gen ?? -1) >= (self.loading[display]?.gen ?? 0) else { return }
                self.drawnSinceRun.insert(display)
                self.fadeOverlay(display, why: "first frame after resume")
                if let want = self.wanted[display], self.drawn[display]?.gen != want.gen {
                    self.settleThenDrawn(display, webView, gen: want.gen)
                } else {
                    self.snapshotIfDue(display, reason: "first frames after resume")
                }
            }
        }
    }

    private func fadeOverlay(_ display: CGDirectDisplayID, why: String) {
        overlayTimeouts.removeValue(forKey: display)?.cancel()
        guard let entry = overlays.removeValue(forKey: display) else { return }
        let view = entry.view
        log(String(format: "overlay: display %u fading out (%@) after %.2f s", display, why, Date().timeIntervalSince(entry.since)))
        testShot(display, "fade", overlay: nil)  // what the lifting picture uncovers
        captureMark(display, "fade starts (\(why))")
        NSAnimationContext.runAnimationGroup { context in
            context.duration = Self.overlayFade
            view.animator().alphaValue = 0
        } completionHandler: {
            MainActor.assumeIsolated {
                self.captureMark(display, "fade done")
                // Not if a new reload has put it back meanwhile.
                if self.overlays[display]?.view !== view { view.removeFromSuperview() }
            }
        }
    }

    // A page that never posts {painted: true} (a design without the runtime, a broken page) must
    // not keep the picture. Only counted while the wallpaper runs: a covered page may not draw.
    private func armOverlayTimeout(_ display: CGDirectDisplayID) {
        overlayTimeouts[display]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.overlayTimeouts[display] = nil
                guard self.overlays[display] != nil else { return }
                if self.running {
                    self.fadeOverlay(display, why: "no paint within \(Int(Self.overlayTimeout)) s")
                } else {
                    log("overlay: display \(display) kept: no paint yet, the wallpaper is paused (\(Int(Self.overlayTimeout)) s more once it runs)")
                }
            }
        }
        overlayTimeouts[display] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.overlayTimeout, execute: work)
    }

    // MARK: Snapshots: the desktop picture and the overlay (Desktop.swift)

    // A page is snapshotted only once its current load has drawn a full line (`painted`): an
    // overlay made from a page with no data was an empty layout, held for 639 s, and at 12:31 on
    // 2026-11-05 another passed the blank check at luma std 5.4. And only while it shows the look
    // it is meant to (pageShowsCurrent), so each file is tagged with what it shows. The newest file
    // of the current look is both the macOS desktop picture (when matching is on; it is written
    // either way) and the overlay over a page that reloads, is drawn unseen, or returns from
    // unseen (WebKit lets a hidden page's pixels go: coverSnapshotEvery).
    // When: as soon as a new design or appearance has drawn (freshDue, once, past the throttle),
    // also unseen; 8 s after a page load (once running, if it loaded under a cover); as the
    // window is covered or the screen locks (at most every coverSnapshotEvery); when matching is
    // switched on; and otherwise (Space changes, the running page) at most every snapshotEvery and
    // only if the page was sent a line since the last one. Each costs ~150-330 ms of async capture,
    // 4-20 ms of WebContent CPU and a ~1-2 MB JPEG written off the main thread.
    private func scheduleDesktopAfterLoad(_ display: CGDirectDisplayID) {
        desktopAfterLoadWork[display]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.desktopAfterLoadWork[display] = nil
                self.snapshotDue.insert(display)
                self.snapshotIfDue(display, reason: "page loaded")
            }
        }
        desktopAfterLoadWork[display] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.desktopAfterLoad, execute: work)
    }

    // A new look (freshDue) is snapshotted as soon as it has drawn on screen, past the throttle and
    // the settle, once: the user's return to the desktop must find the desktop picture of it.
    private func snapshotIfDue(_ display: CGDirectDisplayID, reason: String, force: Bool = false) {
        // Shown, running, and the page showing the look it is meant to (not mid-switch).
        guard running, isShown(display), pageShowsCurrent(display) else { return }
        let fresh = freshDue.contains(display) && drawnSinceRun.contains(display)
        // Otherwise running for a moment: the page has painted since it resumed.
        guard fresh || Date().timeIntervalSince(runningSince) >= Self.snapshotSettle else { return }
        let now = Date()
        let due = snapshotDue.contains(display)
        if !force, !due, !fresh {
            guard sentSinceSnapshot.contains(display),
                  now.timeIntervalSince(lastSnapshot[display] ?? .distantPast) >= Self.snapshotEvery
            else { return }
        }
        freshDue.remove(display)
        snapshotDue.remove(display)
        sentSinceSnapshot.remove(display)
        lastSnapshot[display] = now
        requestSnapshot(display, reason: fresh ? "new look, \(reason)" : due && !force ? "page loaded" : reason)
    }

    // As the window goes unseen: a picture of the page as it was last on screen (with data, of
    // the look it is meant to show), unless one was taken in the last coverSnapshotEvery. False if
    // none is taken (`completion` is then never called).
    private func snapshotAtCover(_ display: CGDirectDisplayID, completion: @escaping (URL?) -> Void) -> Bool {
        guard painted.contains(display), pageShowsCurrent(display), !webViews[display]!.isLoading else { return false }
        let now = Date()
        guard now.timeIntervalSince(lastSnapshot[display] ?? .distantPast) >= Self.coverSnapshotEvery else {
            log(String(format: "desktop: display %u not snapshotted at the cover: the last was %.0f s ago", display,
                       now.timeIntervalSince(lastSnapshot[display]!)))
            return false
        }
        lastSnapshot[display] = now
        sentSinceSnapshot.remove(display)
        requestSnapshot(display, reason: "covered (\(stateText))", completion: completion)
        return true
    }

    // The window, as it goes unseen (covered, locked, hidden), is covered with a picture of the
    // page: the snapshot taken now (snapshotAtCover, ~270 ms, while the paused page still shows
    // the same), else the newest picture of its look, which is then at most coverSnapshotEvery old.
    // The window server shows the window again before this app hears of the return, so a picture
    // put up on the return comes a frame or two late, and in that time the window showed whatever
    // it held unseen. That was the black flash the user saw at 19:52 on 2026-11-05 ("the whole screen
    // blinks ... pitch black for a very, very, very short time"); the host log (pid 14084) has it:
    // - 480 s into a cover WebKit suspends the WebContent process ("View was recently visible
    //   (timeout: 480 sec)") and empties the web view until its first frame after the resume
    //   ("RemoteLayerTreeDrawingAreaProxy::hideContentUntilPendingUpdate", 19:02:54.620), so the
    //   window shows its own background, rgb(11, 17, 32);
    // - the return after 3428 s: "window server visible" at 19:52:02.711, the picture up at .728,
    //   WebKit's content back at .824 ("hideContentUntilPendingUpdate completed"), the fade at .865.
    // The front tile surfaces never went volatile ("Failed to mark layers as volatile within
    // 2000ms", in use by the window), so it is this emptying that showed, not purged tiles.
    private func coverUnseen(_ display: CGDirectDisplayID) {
        if let overlay = overlays[display] {
            return log("overlay: display \(display) already covered while unseen, by a picture of \(overlay.look?.description ?? "?") (\(stateText))")
        }
        let pause = pauses
        let taken = snapshotAtCover(display) { [weak self] url in
            guard let self, self.pauses == pause, !self.running, self.overlays[display] == nil else { return }
            if let url, let image = NSImage(contentsOf: url),
               self.showOverlay(display, image, look: self.currentLook, from: "\(url.lastPathComponent), the page as it went unseen (\(self.stateText))") {
                return
            }
            self.showCurrentPicture(display, why: "unseen, no snapshot (\(self.stateText))")
        }
        if !taken { showCurrentPicture(display, why: "unseen (\(stateText))") }
    }

    private func snapshotEverywhere(reason: String, force: Bool = false) {
        for display in webViews.keys { snapshotIfDue(display, reason: reason, force: force) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        log("page failed to load: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log("page failed: \(error.localizedDescription)")
    }

    // Unplanned: the page is gone, so there is nothing to snapshot; the newest desktop picture
    // (Desktop.swift), if matching has made one, covers the reload instead.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log("WebContent process ended; reloading the page")
        guard let display = webViews.first(where: { $0.value === webView })?.key else { return }
        if overlays[display] == nil { showCurrentPicture(display, why: "WebContent restart") }
        load(display, webView)
    }

    // Private WebKit property, read only for the log line (cost measurement needs the pid).
    static func webProcessID(_ webView: WKWebView) -> Int {
        guard webView.responds(to: NSSelectorFromString("_webProcessIdentifier")) else { return 0 }
        return (webView.value(forKey: "_webProcessIdentifier") as? NSNumber)?.intValue ?? 0
    }

    // MARK: Windows

    // One window per display. Screen parameters change far more often than the screens do (a video
    // wallpaper app measured every brightness-key step posting it), so an existing window is only moved, never
    // rebuilt: rebuilding would reload the page and flash black.
    private func syncWindows() {
        let screens = Dictionary(NSScreen.screens.map { (Self.displayID($0), $0) }) { first, _ in first }
        for (display, window) in windows where screens[display] == nil {
            NotificationCenter.default.removeObserver(
                self, name: NSWindow.didChangeOcclusionStateNotification, object: window)
            window.orderOut(nil)
            windows[display] = nil
            webViews[display] = nil
            desktopAfterLoadWork.removeValue(forKey: display)?.cancel()
            overlays[display] = nil
            overlayTimeouts.removeValue(forKey: display)?.cancel()
            unseen.removeValue(forKey: display)?.cancel()
            loading[display] = nil
            wanted[display] = nil
            drawn[display] = nil
            freshDue.remove(display)
            drawnSinceRun.remove(display)
            painted.remove(display)
            autoDrawn[display] = nil
            log("display \(display) gone: \(windows.count) window(s)")
        }
        for (display, screen) in screens {
            if let window = windows[display] {
                if window.frame != screen.frame { window.setFrame(screen.frame, display: true) }
            } else {
                makeWindow(for: screen, display)
                log("window for display \(display) at \(NSStringFromRect(screen.frame)), level \(windows[display]!.level.rawValue): \(windows.count) in all")
            }
        }
        evaluateCoverage()
    }

    private static func displayID(_ screen: NSScreen) -> CGDirectDisplayID {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    }

    private func makeWindow(for screen: NSScreen, _ display: CGDirectDisplayID) {
        let window = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
        // Just under the desktop icons: above a video wallpaper app (desktop level) and the Dock's wallpaper.
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) - 1)
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.ignoresMouseEvents = true
        window.canHide = false
        window.isOpaque = true
        // Until the page reports its own: what it reported last time, or a neutral.
        window.backgroundColor = DesignBackgrounds.colour(for: currentLook).colour
        window.hasShadow = false
        if testInstance {
            // Never seen: transparent and below the desktop, as Headless's window, which the window
            // server reports occluded: a forced cover then throttles WebKit as a real one does.
            window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
            // Captured (TestCapture.swift): opaque, as the window server applies the alpha to its
            // copy too; still under the desktop, which covers it whole (logged once ordered in).
            window.alphaValue = WindowCapture.folder == nil ? 0 : 1
        }
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none

        let webView = Self.makeWebView(size: screen.frame.size, messages: MessageProxy(self))
        webView.navigationDelegate = self
        // A plain container, so a reload's overlay (an NSImageView) can sit above the web view.
        let container = NSView(frame: NSRect(origin: .zero, size: screen.frame.size))
        container.autoresizingMask = [.width, .height]
        webView.frame = container.bounds
        container.addSubview(webView)
        window.contentView = container
        window.setFrame(screen.frame, display: false)
        if !reasons.contains(.hidden) { window.orderFront(nil) }

        windows[display] = window
        webViews[display] = webView
        if testInstance, WindowCapture.folder != nil {
            captures[display] = WindowCapture(windowID: window.windowNumber, display: display)
            // The capture's own positive control: the launch shows the window's colour, then the page.
            captures[display]?.run("launch", interval: 0, duration: 4)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak window] in
                guard let window else { return }
                log("test: capturing window \(window.windowNumber) on display \(display); the window server reports it \(window.occlusionState.contains(.visible) ? "VISIBLE" : "occluded")")
            }
        }
        applyOcclusionDetection(display)
        // At launch the page draws the saved last state as soon as it has loaded (didFinish,
        // also unseen under a cover); until then the newest picture of its look covers it (none:
        // the window's colour). Quit put the user's own picture back, so the first paint while
        // running sets the desktop picture at once (freshDue).
        showCurrentPicture(display, why: "launch")
        freshDue.insert(display)
        load(display, webView)
        NotificationCenter.default.addObserver(
            self, selector: #selector(occlusionChanged),
            name: NSWindow.didChangeOcclusionStateNotification, object: window)
    }

    @objc private func toggleShown() {
        let show = reasons.contains(.hidden)
        for window in windows.values {
            if show { window.orderFront(nil) } else { window.orderOut(nil) }
        }
        // A window just ordered in reads as occluded until the window server catches up (~20 ms):
        // count it covered until then, rather than starting, stopping and restarting the feed.
        if show { reasons.insert(.covered) }
        set(.hidden, !show)
        evaluateCoverage()
    }

    // MARK: Coverage

    @objc private func occlusionChanged(_ notification: Notification?) {
        evaluateCoverage()
    }

    // Covered = on every screen, either the window server says our window is not visible, or
    // normal windows cover ≥97% of its usable area (see coveredShares). While any window is reported visible, this is
    // re-checked every 2 s, because moving a window over the desktop does not change what the
    // window server reports when it leaves a sliver uncovered.
    private func evaluateCoverage() {
        guard !reasons.contains(.hidden), !windows.isEmpty else {
            stopCoveragePoll()
            return
        }
        let reported = windows.mapValues { $0.occlusionState.contains(.visible) }
        let anyReported = reported.values.contains(true)
        let shares = anyReported ? Self.coveredShares(of: windows.keys) : [:]
        let covered = forcedCover ?? windows.keys.allSatisfy { !reported[$0]! || (shares[$0] ?? 0) >= Self.coveredShare }
        if anyReported { startCoveragePoll() } else { stopCoveragePoll() }
        if covered != reasons.contains(.covered) {
            let detail = windows.keys.sorted().map { display in
                let share = shares[display].map { String(format: "%.1f%%", $0 * 100) } ?? "-"
                return "display \(display): window server \(reported[display]! ? "visible" : "occluded"), windows cover \(share)"
            }.joined(separator: "; ")
            log("coverage: \(detail)")
        }
        set(.covered, covered)
    }

    private func startCoveragePoll() {
        guard coverageTimer == nil else { return }
        let timer = Timer(timeInterval: Self.coveragePoll, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.evaluateCoverage() }
        }
        timer.tolerance = 0.5
        RunLoop.main.add(timer, forMode: .common)
        coverageTimer = timer
    }

    private func stopCoveragePoll() {
        coverageTimer?.invalidate()
        coverageTimer = nil
    }

    // Share of each display's USABLE area (NSScreen.visibleFrame: minus the menu bar and a
    // visible Dock) covered by the UNION of on-screen normal-layer windows of other apps.
    // Two fixes over summing whole-screen areas (open-wallpaper-engine-mac's way), both found
    // on this 1512×982 display: a zoomed window stops below the 33 px menu bar, so it covered
    // at most 96.6% and never counted; and overlapping windows counted twice, so two half
    // windows stacked in one corner could read as "covered". The union is estimated on a
    // 64×40 grid of sample points, which is exact to well under 1% at these sizes.
    private static func coveredShares(of displays: some Collection<CGDirectDisplayID>) -> [CGDirectDisplayID: Double] {
        let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] ?? []
        let me = Int(ProcessInfo.processInfo.processIdentifier)
        let rects: [CGRect] = info.compactMap { window in
            guard (window[kCGWindowLayer as String] as? Int) == 0,
                  (window[kCGWindowOwnerPID as String] as? Int) != me,
                  ((window[kCGWindowAlpha as String] as? Double) ?? 1) > 0,
                  let bounds = window[kCGWindowBounds as String] as? NSDictionary
            else { return nil }
            return CGRect(dictionaryRepresentation: bounds as CFDictionary)
        }
        // Cocoa frames are bottom-left origin relative to the primary screen; the window list is
        // top-left. Flip against the primary screen's height.
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        var shares: [CGDirectDisplayID: Double] = [:]
        for display in displays {
            guard let screen = NSScreen.screens.first(where: {
                ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display
            }) else { continue }
            let v = screen.visibleFrame
            let usable = CGRect(x: v.minX, y: primaryHeight - v.maxY, width: v.width, height: v.height)
            guard usable.width > 0, usable.height > 0 else { continue }
            let here = rects.filter { $0.intersects(usable) }
            let cols = 64, rows = 40
            var hit = 0
            for r in 0..<rows {
                let y = usable.minY + (Double(r) + 0.5) * usable.height / Double(rows)
                for c in 0..<cols {
                    let x = usable.minX + (Double(c) + 0.5) * usable.width / Double(cols)
                    if here.contains(where: { $0.contains(CGPoint(x: x, y: y)) }) { hit += 1 }
                }
            }
            shares[display] = Double(hit) / Double(cols * rows)
        }
        return shares
    }

    // MARK: System state

    private func watchSystem() {
        let distributed = DistributedNotificationCenter.default()
        for (name, locked) in [("com.apple.screenIsLocked", true), ("com.apple.screenIsUnlocked", false)] {
            distributed.addObserver(forName: Notification.Name(name), object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.set(.locked, locked) }
            }
        }
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.syncWindows() }
        }
        NotificationCenter.default.addObserver(
            forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshLowPower() }
        }
        // The desktop picture is per Space; setDesktopImageURL sets only the current one.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.snapshotEverywhere(reason: "Space changed") }
        }
        // `pkill -USR1 KilnWall` toggles show/hide; TERM and INT quit cleanly so the feed child dies too.
        onSignal(SIGUSR1) { $0.toggleShown() }
        if ["1", "covered"].contains(ProcessInfo.processInfo.environment["KILNWALL_TEST_COVER"]) {
            log("test: KILNWALL_TEST_COVER, SIGUSR2 forces desktop covered / uncovered")
            onSignal(SIGUSR2) { app in
                // KILNWALL_TEST_CAPTURE: the window as the window server holds it, read through
                // the cover (4 per second) and back to back from 150 ms before the uncover is
                // handled to 1.5 s after it. Those 150 ms stand for the moment a real return shows
                // the window before this app hears of it: they show what the window held unseen.
                guard !app.captures.isEmpty else { return app.flipForcedCover() }
                if app.forcedCover == true {
                    for capture in app.captures.values { capture.run("uncover", interval: 0, duration: 1.65) }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        MainActor.assumeIsolated {
                            for capture in app.captures.values { capture.mark("uncover handled") }
                            app.flipForcedCover()
                        }
                    }
                } else {
                    app.flipForcedCover()
                    // KILNWALL_TEST_CAPTURE_COVER=0: not read through the cover (a read may keep
                    // the window's surfaces in use, which WebKit checks before letting them go).
                    if ProcessInfo.processInfo.environment["KILNWALL_TEST_CAPTURE_COVER"] != "0" {
                        for capture in app.captures.values { capture.run("cover", interval: 0.25, duration: nil) }
                    }
                }
            }
        }
        onSignal(SIGTERM) { _ in NSApp.terminate(nil) }
        onSignal(SIGINT) { _ in NSApp.terminate(nil) }
    }

    // SIGUSR2 in a test instance: a forced cover or uncover.
    private func flipForcedCover() {
        forcedCover = !(forcedCover ?? false)
        log("test: forced \(forcedCover! ? "covered" : "uncovered")")
        for display in webViews.keys { applyOcclusionDetection(display) }
        // What a real cover sends: WebKit re-reads its view's visibility on this
        // notification, not when its occlusion check is switched.
        for window in windows.values {
            NotificationCenter.default.post(name: NSWindow.didChangeOcclusionStateNotification, object: window)
        }
        // A WebContent process told it would suspend (KILNWALL_TEST_SUSPEND) is resumed as the
        // view becomes visible, as WebKit does itself for a really suspended one (it sent
        // ProcessDidResume 2 ms after the view turned visible at 19:52:02.730 on 2026-11-05).
        if forcedCover == false, testSuspended {
            testSuspended = false
            let selector = NSSelectorFromString("_processDidResumeForTesting")
            for webView in webViews.values where webView.responds(to: selector) {
                webView.perform(selector)
                log("test: WebContent told it resumed")
            }
        }
        evaluateCoverage()
        forcedCovers += 1
        // KILNWALL_TEST_SUSPEND=<s>: WebKit's own test hook for a WebContent process about to be
        // suspended (a long-hidden page), this many seconds into the cover.
        if forcedCover == true, let after = ProcessInfo.processInfo.environment["KILNWALL_TEST_SUSPEND"].flatMap(Double.init) {
            let cover = forcedCovers
            DispatchQueue.main.asyncAfter(deadline: .now() + after) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.forcedCovers == cover, self.forcedCover == true else { return }
                    let selector = NSSelectorFromString("_processWillSuspendForTesting:")
                    for (display, webView) in self.webViews where webView.responds(to: selector) {
                        self.testSuspended = true
                        self.captureMark(display, "WebContent told it will suspend")
                        typealias Suspend = @convention(c) (AnyObject, Selector, @escaping @convention(block) () -> Void) -> Void
                        let started = Date()
                        unsafeBitCast(webView.method(for: selector), to: Suspend.self)(webView, selector) {
                            log(String(format: "test: WebContent told it will suspend, done in %.0f ms", Date().timeIntervalSince(started) * 1000))
                        }
                    }
                }
            }
        }
        if forcedCover == true, let after = WindowCapture.purgeAfter {
            let cover = forcedCovers
            DispatchQueue.main.asyncAfter(deadline: .now() + after) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.forcedCovers == cover, self.forcedCover == true else { return }
                    for (display, webView) in self.webViews {
                        guard let layer = webView.layer else { continue }
                        log(String(format: "test: purge %.0f s into the cover, display %u: ", after, display) + WindowCapture.purgeVolatile(layer))
                        self.captureMark(display, "purged")
                    }
                }
            }
        }
        // What the window shows at the instant of the uncover, after the return's own work.
        if forcedCover == false {
            for display in windows.keys {
                log("test: at the uncover display \(display): page \(painted.contains(display) ? "has drawn data" : "has drawn NO data") (\(drawn[display]?.look.description ?? "nothing drawn")), overlay \(overlays[display].map { "up, of \($0.look?.description ?? "?")" } ?? "none")")
                testShot(display, "uncover", overlay: overlays[display]?.view.image)
            }
        }
    }

    private func captureMark(_ display: CGDirectDisplayID, _ what: String) {
        captures[display]?.mark(what)
    }

    private func onSignal(_ number: Int32, _ handler: @escaping (KilnWall) -> Void) {
        signal(number, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated { if let self { handler(self) } }
        }
        source.resume()
        signals.append(source)
    }

    private func refreshLowPower() {
        set(.lowPower, ProcessInfo.processInfo.isLowPowerModeEnabled)
    }

    // MARK: Menu bar

    // The menu itself is Menu.swift; it asks for menuState() when it opens and on every change
    // while open, and calls back into the same paths as the hotkeys, the CLI and the system.
    private func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let image = NSImage(systemSymbolName: "chart.xyaxis.line", accessibilityDescription: "KilnWall") {
            item.button?.image = image
        } else {
            item.button?.title = "◫"
        }
        let menu = KilnMenu(min: Settings.minPeriod, max: Settings.maxPeriod, step: Settings.step) { [unowned self] in
            self.menuState()
        }
        menu.willOpen = { [unowned self] in self.refreshDesignPictures() }
        menu.setPeriod = { [unowned self] in self.setPeriod($0, source: "menu") }
        menu.stepPeriod = { [unowned self] in self.stepPeriod($0, source: "menu") }
        menu.chooseDesign = { [unowned self] in self.chooseDesign($0) }
        menu.setAppearance = { [unowned self] appearance in
            var next = self.settings
            next.appearance = appearance
            self.choose(next, source: "menu")
        }
        menu.setTempUnit = { [unowned self] unit in
            var next = self.settings
            next.tempUnit = unit
            self.choose(next, source: "menu")
        }
        menu.setMatchDesktop = { [unowned self] in self.setMatchDesktop($0) }
        menu.setLaunchAtLogin = { [unowned self] in self.setLaunchAtLogin($0) }
        menu.togglePause = { [unowned self] in self.togglePause() }
        menu.toggleShown = { [unowned self] in self.toggleShown() }
        menu.reloadPage = { [unowned self] in self.reloadPage() }
        menu.openPageFolder = { [unowned self] in self.openPageFolder() }
        item.menu = menu.menu
        statusItem = item
        self.menu = menu
    }

    private func menuState() -> MenuState {
        let designs = Designs.list()
        let shown = target.design.flatMap { id in designs.first { $0.id == id }?.name }
        return MenuState(
            light: reasons.isEmpty ? .running : reasons == [.covered] ? .covered : .paused,
            // "Paused by you", "Desktop covered, Low Power Mode": the light already says paused.
            stateText: reasons.isEmpty ? "Running" : PauseReason.allCases.filter(reasons.contains)
                .map(\.rawValue).joined(separator: ", ").capitalisingFirst,
            // Under a cover the feed runs slower than the period: say so.
            feedText: holding ? "\(feed.source), held at \(feed.periodMs) ms" : feed.source,
            designName: shown ?? target.label,
            periodMs: settings.periodMs,
            designs: designs.map { MenuState.DesignEntry(id: $0.id, name: $0.name, hasPage: $0.hasPage) },
            currentDesign: target.design,
            designsFolder: (Designs.root.path as NSString).abbreviatingWithTildeInPath,
            hidden: reasons.contains(.hidden),
            pausedByYou: reasons.contains(.manual),
            matchDesktop: settings.matchDesktop,
            launchAtLogin: SMAppService.mainApp.status == .enabled,
            appearance: settings.appearance,
            tempUnit: settings.tempUnit)
    }

    // The grid's pictures, each from the main display's newest desktop snapshot of that design.
    // The design is read from the snapshot's own tag (Desktop.swift), set when it was taken and
    // checked against the page when it completed, never inferred from timing: before, a picture
    // was "of the shown design" when newer than its last paint, so a snapshot of the old design
    // still being written across a switch, or a {painted} from the page a switch replaced, filed
    // the old design's picture under the new one.
    private func refreshDesignPictures() {
        guard let screen = NSScreen.screens.first else { return }
        for (design, picture) in DesktopMatcher.newestByDesign(Self.displayID(screen)) where Designs.isValidID(design) {
            if DesignPictures.refresh(design, from: picture.url) {
                log("menu: picture of design \(design) from \(picture.url.lastPathComponent)")
            }
        }
    }

    private func chooseDesign(_ id: String) {
        var next = settings
        next.design = id
        choose(next, source: "menu")
    }

    private func setMatchDesktop(_ on: Bool) {
        var next = settings
        next.matchDesktop = on
        choose(next, source: "menu")
    }

    private func togglePause() {
        set(.manual, !reasons.contains(.manual))
    }

    private func reloadPage() {
        // A design (or the old page folder) may have appeared since: pick it up.
        log("reloading the page (menu)")
        let before = target
        retarget()
        if target == before { reloadPages() }
    }

    private func openPageFolder() {
        NSWorkspace.shared.open(target.index.deletingLastPathComponent())
    }

    // Returns whether it is on now. A failure is shown once the menu has closed.
    private func setLaunchAtLogin(_ on: Bool) -> Bool {
        do {
            if on {
                try SMAppService.mainApp.register()
                log("launch at login on")
            } else {
                try SMAppService.mainApp.unregister()
                log("launch at login off")
            }
        } catch {
            log("launch at login: \(error.localizedDescription)")
            menu?.menu.cancelTracking()
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = "Couldn't change Launch at Login"
                alert.informativeText = error.localizedDescription
                NSApp.activate()
                alert.runModal()
            }
        }
        return SMAppService.mainApp.status == .enabled
    }
}

private extension String {
    var capitalisingFirst: String { prefix(1).uppercased() + dropFirst() }
}

// The user content controller retains its handlers; this keeps it from retaining the app.
@MainActor
private final class MessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: KilnWall?
    init(_ target: KilnWall) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.pageSaid(message)
    }
}

// FSEvents on folders (recursive, file-level), delivered on the main queue with the changed paths.
@MainActor
final class FolderWatcher {
    private var stream: FSEventStreamRef?
    private let onChange: ([String]) -> Void

    init(_ folders: [URL], onChange: @escaping ([String]) -> Void) {
        self.onChange = onChange
        let paths = folders.map(\.path)
        var context = FSEventStreamContext(
            version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, _, eventPaths, _, _ in
            guard let info else { return }
            let watcher = Unmanaged<FolderWatcher>.fromOpaque(info).takeUnretainedValue()
            // kFSEventStreamCreateFlagUseCFTypes: the paths are a CFArray of CFString.
            let paths = Unmanaged<CFArray>.fromOpaque(eventPaths).takeUnretainedValue() as? [String] ?? []
            MainActor.assumeIsolated { watcher.onChange(paths) }
        }
        guard let stream = FSEventStreamCreate(
            nil, callback, &context, paths as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.05,
            FSEventStreamCreateFlags(
                kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagUseCFTypes))
        else {
            log("cannot watch \(paths.joined(separator: ", "))")
            return
        }
        FSEventStreamSetDispatchQueue(stream, .main)
        FSEventStreamStart(stream)
        self.stream = stream
        log("watching \(paths.joined(separator: ", ")) for changes")
    }

    deinit {
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }
}

MainActor.assumeIsolated {
    // A write to a feed that just died must fail with EPIPE, not kill the app.
    signal(SIGPIPE, SIG_IGN)
    // Before anything starts: `--help` must not launch the wallpaper.
    if CommandLine.arguments.dropFirst().contains(where: { $0 == "--help" || $0 == "-h" }) {
        print(HeadlessOptions.usage)
        exit(0)
    }
    let app = NSApplication.shared
    // `--snapshot` / `--measure`: the headless modes (Headless.swift), nothing of the wallpaper.
    let headless: HeadlessOptions?
    do {
        headless = try HeadlessOptions.parse(CommandLine.arguments)
    } catch {
        FileHandle.standardError.write(Data("KilnWall: \(error)\n\n\(HeadlessOptions.usage)\n".utf8))
        exit(64)
    }
    if let headless {
        let delegate = Headless(headless)
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    } else {
        let delegate = KilnWall()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
