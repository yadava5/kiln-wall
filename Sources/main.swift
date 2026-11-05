// KilnWall — a local HTML dashboard as the desktop wallpaper, fed live JSON.
//
// One borderless window per screen sits one level below the desktop icons (so above LiveWall's
// video, which sits at the desktop level) and holds a WKWebView showing the chosen design,
// ~/.config/kiln-wall/designs/<design>/index.html. Each JSON line from the feed (Feed.swift) is
// handed to the page as its raw text, window.kiln.update(line), and the design and refresh period (100..1000 ms,
// settings.json, see Settings.swift) as window.kiln.config({design, period_ms}). Whenever nobody
// can see the wallpaper the page is told window.kiln.pause() and the feed is stopped, except
// under a cover (a window or full-screen Space over the desktop): then the feed runs on for a
// grace period at 1 s, its lines kept but not sent, so a quick return shows the latest state at
// once (see coveredGrace).
//
// The page never shows blank (Ayush, 2026-11-05): a page that (re)loads is sent the latest state
// as its first line, and a snapshot of the old page is laid over it until it has painted.
//
// The period and design change live, from the menu-bar item (Menu.swift), the global hotkeys ⌃⌥= (faster,
// −100 ms) and ⌃⌥- (slower, +100 ms), or the `kiln-wall` CLI, which writes settings.json.
//
// The macOS desktop picture is kept matched to the wallpaper (Desktop.swift), because Mission
// Control and Space switches show the system's picture, not this window.
import AppKit
import Carbon.HIToolbox
import os
import ServiceManagement
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
    // An overlay picture whose luma varies less than this is a blank page: not shown.
    private static let blankLumaStd = 3.0
    // Covered: the feed is kept this long at coveredPeriodMs, so a return within it shows the
    // state of a second ago at once. Measured 2026-11-05 (kiln-feed --stream --period-ms 1000,
    // 150 s, load average 2.3-3.5): own CPU 1.17% of a core (0.87-1.43% per 30 s), 2.5% with the
    // ps/netstat/pmset children it forks; a fresh start costs 90 ms of CPU and its first line
    // comes one period later. So a full grace costs ~3 CPU-seconds; 120 s is Ayush's "a minute or
    // two", and a cover that outlasts it stops the feed as before.
    private static let coveredGrace: TimeInterval = 120
    private static let coveredPeriodMs = 1000
    // A reloading page's overlay (a snapshot of it before the reload) fades out over this once the
    // page has painted its first line, and goes after overlayTimeout anyway (while it is seen).
    private static let overlayFade: TimeInterval = 0.2
    private static let overlayTimeout: TimeInterval = 3
    // Until a page reports its own: glass's #0b1120 (the default design).
    private static let defaultBackground = NSColor(srgbRed: 11 / 255, green: 17 / 255, blue: 32 / 255, alpha: 1)

    private var windows: [CGDirectDisplayID: NSWindow] = [:]
    private var webViews: [CGDirectDisplayID: WKWebView] = [:]
    private var reasons: Set<PauseReason> = []
    private var running = false  // page told to animate (and the feed on, its lines sent)
    // Covered, within the grace: the feed runs at coveredPeriodMs and its lines are kept, not sent.
    private var holding = false
    private var graceWork: DispatchWorkItem?
    private var graceStarted = Date()
    private var graceCPU: Double?
    // Lines kept since the page was last sent one: it is sent `replay.latest()` when it runs again.
    private var heldUnsent = false
    private var overlays: [CGDirectDisplayID: (view: NSImageView, since: Date)] = [:]
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
    // When the shown design last painted: a desktop snapshot newer than this is a picture of it,
    // for the menu's design grid (DesignPictures, Menu.swift).
    private var painted: (design: String, at: Date)?
    private let feed = Feed()
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
        log("started; design \(settings.design), period \(settings.periodMs) ms, match desktop \(settings.matchDesktop); designs in \(Designs.root.path)")
        logTarget()
        // Matching was switched off while this was not running (or it quit without restoring).
        if !settings.matchDesktop { desktop.restore(reason: "matching is off") }
        feed.setPeriod(settings.periodMs)
        feed.onLine = { [weak self] line in self?.push(line) }
        buildStatusItem()
        watchPageFolder()
        settingsWatcher = SettingsWatcher { [weak self] in self?.settingsFileChanged() }
        registerHotkeys()
        watchSystem()
        syncWindows()
        refreshLowPower()
        apply()
    }

    func applicationWillTerminate(_ notification: Notification) {
        feed.stop()
        desktop.enabled = false
        desktop.restore(reason: "quit")
        log("quit")
    }

    // MARK: Running and pausing

    private func set(_ reason: PauseReason, _ active: Bool) {
        let changed = active ? reasons.insert(reason).inserted : reasons.remove(reason) != nil
        guard changed else { return }
        log("\(active ? "+" : "-") \(reason.rawValue)")
        apply()
    }

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
                if reloadOnRun {
                    // Changed while nobody could see it: reload now, under the last snapshot.
                    reloadOnRun = false
                    log("page: reloading on return (changed while paused)")
                    for (display, webView) in webViews {
                        if overlays[display] != nil || showNewestPicture(display, why: "reload on return") {
                            load(webView)
                        } else {
                            reload(display, webView)  // no picture yet: a snapshot of the page first
                        }
                    }
                } else {
                    // Past the grace, cover the return with the last snapshot until the page's first
                    // frame after resume: in case WebKit dropped the pixels of a long-hidden page.
                    if away >= Self.coveredGrace {
                        for display in webViews.keys where overlays[display] == nil {
                            showNewestPicture(display, why: String(format: "return after %.0f s", away))
                        }
                    }
                    // While the page is still paused, so its figures snap to the state instead of
                    // gliding from the old one; the feed's next line follows within one period.
                    if heldUnsent { sendLatest(why: kept ? "uncovered within the grace" : "running again") }
                }
                evaluateEverywhere("window.kiln && window.kiln.resume && window.kiln.resume()")
                liftOverlaysAfterFirstFrame()
                for display in overlays.keys where overlayTimeouts[display] == nil { armOverlayTimeout(display) }
                log((kept ? "running (feed kept through the cover, \(feed.mode))" : "running") + String(format: " after %.1f s paused", away))
            } else {
                pausedSince = Date()
                runningSince = .distantFuture
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
        configureEverywhere()
        menu?.refresh()
    }

    // A choice made here: apply, then record it in settings.json.
    private func choose(_ new: Settings, source: String) {
        if new == settings {
            log("\(source): already design \(new.design), period \(new.periodMs) ms, match desktop \(new.matchDesktop)")
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
        reloadPages()
    }

    private func logTarget() {
        if target.design == settings.design {
            log("page: \(target.label), \(target.index.path)")
        } else {
            log("page: design \(settings.design) has no index.html in \(Designs.root.path); showing \(target.label) (\(target.index.path))")
        }
    }

    // What the page is told: the design it is (the chosen one, or the fallback actually shown).
    private var pageConfig: [String: Any] {
        ["design": target.design ?? settings.design, "period_ms": settings.periodMs]
    }

    private func configureEverywhere() {
        for webView in webViews.values { configure(webView) }
    }

    private func configure(_ webView: WKWebView) {
        Self.configure(webView, pageConfig) { [weak self] error in self?.scriptFailed(error) }
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

    // {design, period_ms} for the page: after every load and on every change.
    static func configure(_ webView: WKWebView, _ config: [String: Any], onError: @escaping (Error) -> Void) {
        webView.callAsyncJavaScript(
            "window.kiln && window.kiln.config && window.kiln.config(c)", arguments: ["c": config], in: nil, in: .page
        ) { result in
            if case .failure(let error) = result { onError(error) }
        }
    }

    private func load(_ webView: WKWebView) {
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
    // snapshot of the page as it is goes over it first, so the reload never shows blank.
    private func reloadPages() {
        guard running else {
            if !reloadOnRun { log("page: reload deferred until the wallpaper runs (\(stateText))") }
            reloadOnRun = true
            return
        }
        for (display, webView) in webViews { reload(display, webView) }
    }

    private func reload(_ display: CGDirectDisplayID, _ webView: WKWebView) {
        // Still covering a load that has not painted: that picture is the right one, not a new
        // snapshot of a half-loaded page.
        if overlays[display] != nil {
            armOverlayTimeout(display)
            return load(webView)
        }
        // Only a page on screen is snapshotted; otherwise the newest snapshot of one.
        guard windows[display]?.occlusionState.contains(.visible) == true else {
            showNewestPicture(display, why: "reload")
            return load(webView)
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
                if let image, self.showOverlay(display, image, from: String(format: "a snapshot of the running page (%.0f ms)", ms)) {
                } else {
                    if image == nil { log("overlay: display \(display) snapshot failed: \(error?.localizedDescription ?? "no image")") }
                    self.showNewestPicture(display, why: "reload")
                }
                self.load(webView)
            }
        }
    }

    private func push(_ line: String) {
        replay.note(line)
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
    private func sendLatest(why: String) {
        heldUnsent = false
        guard let latest = replay.latest() else { return }
        for webView in webViews.values {
            Self.send(latest.line, to: webView) { [weak self] error in self?.scriptFailed(error) }
        }
        log("page: sent the latest state (\(why)), \(Self.age(latest.t)), \(latest.line.utf8.count) bytes")
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
            log("page painted on display \(display)")
            if let design = target.design { painted = (design, Date()) }
            fadeOverlay(display, why: "page painted")
            return
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
        // The whole latest state as the page's first line, so it draws at once (and posts
        // {painted: true}) instead of waiting for the feed's next line, or for an uncover.
        if let latest = replay.latest() {
            log("page: sent the latest state on load, \(Self.age(latest.t)), with \(replay.held)")
            Self.send(latest.line, to: webView) { [weak self] error in self?.scriptFailed(error) }
        }
        readBackground(display, webView)
        scheduleDesktopAfterLoad(display)
    }

    // The window shows its background wherever the page has not drawn (before its first paint,
    // during a WebContent restart): the page's own colour, not black.
    private func readBackground(_ display: CGDirectDisplayID, _ webView: WKWebView) {
        let script = """
            const css = (e) => e ? getComputedStyle(e).backgroundColor : "";
            return [css(document.body), css(document.documentElement)];
            """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self, case .success(let value) = result, let colours = value as? [String] else { return }
            guard let colour = colours.lazy.compactMap(Self.opaqueColour).first,
                  let window = self.windows[display], window.backgroundColor != colour else { return }
            window.backgroundColor = colour
            log("window background on display \(display): \(colours.first { Self.opaqueColour($0) != nil } ?? "?") from the page")
        }
    }

    // "rgb(11, 17, 32)" or "rgba(r, g, b, a)" with a > 0.
    private static func opaqueColour(_ css: String) -> NSColor? {
        guard let open = css.firstIndex(of: "("), let close = css.lastIndex(of: ")") else { return nil }
        let parts = css[css.index(after: open)..<close].split(separator: ",").compactMap {
            Double($0.trimmingCharacters(in: .whitespaces))
        }
        guard parts.count >= 3, parts.count == 4 ? parts[3] > 0 : true else { return nil }
        return NSColor(srgbRed: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255, alpha: 1)
    }

    // MARK: Overlay over a reloading or returning page

    // Every picture is checked before it is shown: its luma over a 48x30 grid, logged, and refused
    // when it is a uniform field (a blank page). A populated page has a std of ~20 (glass).
    @discardableResult
    private func showOverlay(_ display: CGDirectDisplayID, _ image: NSImage, from source: String) -> Bool {
        guard let container = windows[display]?.contentView else { return false }
        let stats = Self.lumaStats(image)
        let described = stats.map { String(format: "luma mean %.1f std %.1f", $0.mean, $0.std) } ?? "luma unknown"
        guard let stats, stats.std >= Self.blankLumaStd else {
            log("overlay: display \(display) refused \(source): blank (\(described))")
            return false
        }
        let view = overlays[display]?.view ?? NSImageView(frame: container.bounds)
        view.image = image
        view.imageScaling = .scaleAxesIndependently
        view.autoresizingMask = [.width, .height]
        view.wantsLayer = true
        view.alphaValue = 1
        if view.superview == nil { container.addSubview(view, positioned: .above, relativeTo: nil) }
        overlays[display] = (view, Date())
        armOverlayTimeout(display)
        log("overlay: display \(display) shows \(source), \(described), until the page paints")
        return true
    }

    // The newest snapshot of the running page (written by DesktopMatcher, see snapshotIfDue).
    @discardableResult
    private func showNewestPicture(_ display: CGDirectDisplayID, why: String) -> Bool {
        guard let url = DesktopMatcher.newestPicture(display), let image = NSImage(contentsOf: url) else {
            log("overlay: display \(display) has no picture to show (\(why))")
            return false
        }
        let age = ((try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate)
            .map { String(format: ", %.0f s old", Date().timeIntervalSince($0)) } ?? ""
        return showOverlay(display, image, from: "\(url.lastPathComponent)\(age) (\(why))")
    }

    // After resume(): the page's first two frames, then the overlay goes. A page held by a cover
    // has posted {painted} long ago, so the host waits on the frames itself.
    private func liftOverlaysAfterFirstFrame() {
        for (display, webView) in webViews where overlays[display] != nil {
            webView.callAsyncJavaScript(
                "await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
                arguments: [:], in: nil, in: .page
            ) { [weak self] result in
                guard let self, self.webViews[display] === webView, self.running else { return }
                if case .failure(let error) = result { return self.scriptFailed(error) }
                // A page still loading has its own {painted} to wait for.
                if !webView.isLoading { self.fadeOverlay(display, why: "first frame after resume") }
            }
        }
    }

    private static func lumaStats(_ image: NSImage) -> (mean: Double, std: Double)? {
        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let width = 48, height = 30
        var pixels = [UInt8](repeating: 0, count: width * height)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
            else { return false }
            context.interpolationQuality = .medium
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }
        let count = Double(pixels.count)
        let mean = pixels.reduce(0.0) { $0 + Double($1) } / count
        let variance = pixels.reduce(0.0) { $0 + (Double($1) - mean) * (Double($1) - mean) } / count
        return (mean, variance.squareRoot())
    }

    private func fadeOverlay(_ display: CGDirectDisplayID, why: String) {
        overlayTimeouts.removeValue(forKey: display)?.cancel()
        guard let entry = overlays.removeValue(forKey: display) else { return }
        let view = entry.view
        log(String(format: "overlay: display %u fading out (%@) after %.2f s", display, why, Date().timeIntervalSince(entry.since)))
        NSAnimationContext.runAnimationGroup { context in
            context.duration = Self.overlayFade
            view.animator().alphaValue = 0
        } completionHandler: {
            MainActor.assumeIsolated {
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

    // A page is snapshotted only while the wallpaper runs (on screen and drawing): a covered or
    // paused web view may hold nothing current, and an overlay made from one was blank and held
    // for 639 s (2026-11-05). The newest file per display is both the macOS desktop picture (when
    // matching is on; it is written either way) and the overlay over a page that reloads unplanned,
    // reloads on return from a cover, or returns from a long cover.
    // When: 8 s after a page load (once running, if it loaded under a cover), when matching is
    // switched on, and otherwise (Space changes, the running page) at most every snapshotEvery and
    // only if the page was sent a line since the last one. Each costs ~100-220 ms of async
    // capture, 3-6 ms of WebContent CPU and a ~1 MB JPEG written off the main thread.
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

    private func snapshotIfDue(_ display: CGDirectDisplayID, reason: String, force: Bool = false) {
        // Running (so shown and uncovered) for a moment: the page has painted since it resumed.
        guard running, Date().timeIntervalSince(runningSince) >= Self.snapshotSettle,
              windows[display]?.occlusionState.contains(.visible) == true else { return }
        let now = Date()
        let due = snapshotDue.contains(display)
        if !force, !due {
            guard sentSinceSnapshot.contains(display),
                  now.timeIntervalSince(lastSnapshot[display] ?? .distantPast) >= Self.snapshotEvery
            else { return }
        }
        snapshotDue.remove(display)
        sentSinceSnapshot.remove(display)
        lastSnapshot[display] = now
        desktop.update(display, reason: due && !force ? "page loaded" : reason)
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
        if let display = webViews.first(where: { $0.value === webView })?.key, overlays[display] == nil {
            showNewestPicture(display, why: "WebContent restart")
        }
        load(webView)
    }

    // Private WebKit property, read only for the log line (cost measurement needs the pid).
    static func webProcessID(_ webView: WKWebView) -> Int {
        guard webView.responds(to: NSSelectorFromString("_webProcessIdentifier")) else { return 0 }
        return (webView.value(forKey: "_webProcessIdentifier") as? NSNumber)?.intValue ?? 0
    }

    // MARK: Windows

    // One window per display. Screen parameters change far more often than the screens do (LiveWall
    // measured every brightness-key step posting it), so an existing window is only moved, never
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
        // Just under the desktop icons: above LiveWall (desktop level) and the Dock's wallpaper.
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) - 1)
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.ignoresMouseEvents = true
        window.canHide = false
        window.isOpaque = true
        window.backgroundColor = Self.defaultBackground
        window.hasShadow = false
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
        // At launch the page has no data until the feed's first line: the last snapshot covers it.
        showNewestPicture(display, why: "launch")
        load(webView)
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
        if ProcessInfo.processInfo.environment["KILNWALL_TEST_COVER"] == "1" {
            log("test: KILNWALL_TEST_COVER=1, SIGUSR2 forces desktop covered / uncovered")
            onSignal(SIGUSR2) { app in
                app.forcedCover = !(app.forcedCover ?? false)
                log("test: forced \(app.forcedCover! ? "covered" : "uncovered")")
                app.evaluateCoverage()
            }
        }
        onSignal(SIGTERM) { _ in NSApp.terminate(nil) }
        onSignal(SIGINT) { _ in NSApp.terminate(nil) }
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
        menu.willOpen = { [unowned self] in self.refreshDesignPicture() }
        menu.setPeriod = { [unowned self] in self.setPeriod($0, source: "menu") }
        menu.stepPeriod = { [unowned self] in self.stepPeriod($0, source: "menu") }
        menu.chooseDesign = { [unowned self] in self.chooseDesign($0) }
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
            launchAtLogin: SMAppService.mainApp.status == .enabled)
    }

    // The shown design's picture in the grid, from the main display's newest desktop snapshot,
    // when that was taken after the design last painted (so it is of this design, drawn).
    private func refreshDesignPicture() {
        guard let painted, painted.design == target.design, let screen = NSScreen.screens.first,
              let snapshot = DesktopMatcher.newestPicture(Self.displayID(screen)),
              let taken = DesignPictures.modified(snapshot), taken > painted.at
        else { return }
        if DesignPictures.refresh(painted.design, from: snapshot) {
            log("menu: picture of design \(painted.design) from \(snapshot.lastPathComponent)")
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
