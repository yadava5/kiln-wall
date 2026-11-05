// KilnWall — a local HTML dashboard as the desktop wallpaper, fed live JSON.
//
// One borderless window per screen sits one level below the desktop icons (so above LiveWall's
// video, which sits at the desktop level) and holds a WKWebView showing the chosen design,
// ~/.config/kiln-wall/designs/<design>/index.html. Each JSON line from the feed (Feed.swift) is
// handed to the page as its raw text, window.kiln.update(line), and the design and refresh period (100..1000 ms,
// settings.json, see Settings.swift) as window.kiln.config({design, period_ms}). Whenever nobody
// can see the wallpaper the feed is stopped and the page is told window.kiln.pause().
//
// The period and design change live, from the menu-bar item, the global hotkeys ⌃⌥= (faster,
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
final class KilnWall: NSObject, NSApplicationDelegate, NSMenuDelegate, WKNavigationDelegate {
    // Normal windows covering at least this share of a screen count as covering it. The window
    // server alone reports the gaps between tiled windows and the translucent menu bar as visible.
    private static let coveredShare = 0.97
    private static let coveragePoll: TimeInterval = 2
    private static let reloadDebounce: TimeInterval = 0.3
    // Desktop picture updates (see Desktop.swift): this long after a page load, and when paused at
    // most this often.
    private static let desktopAfterLoad: TimeInterval = 8
    private static let desktopWhilePausedEvery: TimeInterval = 120

    private var windows: [CGDirectDisplayID: NSWindow] = [:]
    private var webViews: [CGDirectDisplayID: WKWebView] = [:]
    private var reasons: Set<PauseReason> = []
    private var running = false  // feed on and page told to animate
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
    private var stateItem: NSMenuItem?
    private var feedItem: NSMenuItem?
    private var showItem: NSMenuItem?
    private var pauseItem: NSMenuItem?
    private var loginItem: NSMenuItem?
    private var designMenu: NSMenu?
    private var designMenuItem: NSMenuItem?
    private var refreshMenu: NSMenu?
    private var refreshMenuItem: NSMenuItem?
    private var matchItem: NSMenuItem?
    private let feed = Feed()
    private var acknowledged = 0
    private var scriptErrors = 0
    private var replay = ReplayCache()
    private lazy var desktop = DesktopMatcher(enabled: settings.matchDesktop) { [weak self] in self?.webViews[$0] }
    private var desktopAfterLoadWork: [CGDirectDisplayID: DispatchWorkItem] = [:]
    private var lastPausedDesktop: Date?

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

    private func apply() {
        let shouldRun = reasons.isEmpty
        if shouldRun != running {
            running = shouldRun
            if shouldRun {
                feed.start()
                evaluateEverywhere("window.kiln && window.kiln.resume && window.kiln.resume()")
                log("running")
            } else {
                feed.stop()
                // Before pause(): the snapshot should show the page as it ran, not its paused look.
                desktopWhilePaused()
                evaluateEverywhere("window.kiln && window.kiln.pause && window.kiln.pause()")
                log("paused: \(stateText)")
            }
        }
        statusItem?.button?.appearsDisabled = !running
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
            feed.setPeriod(new.periodMs)
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
                updateDesktopEverywhere(reason: "matching switched on")
            } else {
                desktop.restore(reason: "matching switched off")
            }
        }
        configureEverywhere()
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

    private func stepPeriod(_ delta: Int, source: String) {
        var next = settings
        next.periodMs = Settings.clamp(settings.periodMs + delta)
        choose(next, source: source)
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
        // Let the black window show until the page paints, instead of WebKit's white.
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .black
        return webView
    }

    // A design reads the whole designs folder (its pages load ../_shared/kiln-runtime.js).
    static func loadPage(_ webView: WKWebView, _ target: PageTarget) {
        webView.loadFileURL(target.index, allowingReadAccessTo: target.readAccess)
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

    private func reloadPages() {
        for webView in webViews.values { load(webView) }
    }

    private func push(_ line: String) {
        replay.note(line)
        for webView in webViews.values {
            Self.send(line, to: webView) { [weak self] error in self?.scriptFailed(error) }
        }
    }

    private func evaluateEverywhere(_ body: String) {
        for webView in webViews.values {
            webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { [weak self] result in
                if case .failure(let error) = result { self?.scriptFailed(error) }
            }
        }
    }

    // A broken page would otherwise log once a second.
    private func scriptFailed(_ error: Error) {
        scriptErrors += 1
        if scriptErrors <= 3 || scriptErrors % 60 == 0 {
            log("page script error #\(scriptErrors): \(error.localizedDescription)")
        }
    }

    // window.webkit.messageHandlers.kiln.postMessage(...) from the page: logged as proof of delivery.
    fileprivate func pageSaid(_ message: WKScriptMessage) {
        acknowledged += 1
        guard acknowledged == 1 || acknowledged % 10 == 0 else { return }
        let display = webViews.first { $0.value === message.webView }?.key ?? 0
        let body = (try? JSONSerialization.data(withJSONObject: message.body))
            .map { String(decoding: $0, as: UTF8.self) } ?? "\(message.body)"
        log("page ack #\(acknowledged) on display \(display): \(body)")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let display = webViews.first { $0.value === webView }?.key ?? 0
        log("page loaded on display \(display) (WebContent pid \(Self.webProcessID(webView)))")
        scriptErrors = 0
        configure(webView)
        // A partial update: the page merges it with the next full line.
        if let line = replay.line {
            log("page: replayed \(replay.held)")
            Self.send(line, to: webView) { [weak self] error in self?.scriptFailed(error) }
        }
        if !running {
            webView.callAsyncJavaScript(
                "window.kiln && window.kiln.pause && window.kiln.pause()", arguments: [:], in: nil, in: .page)
        }
        scheduleDesktopAfterLoad(display)
    }

    // MARK: Desktop picture (Desktop.swift)

    // The one timed update: once the page has loaded and drawn its data.
    private func scheduleDesktopAfterLoad(_ display: CGDirectDisplayID) {
        desktopAfterLoadWork[display]?.cancel()
        guard settings.matchDesktop else { return }
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.desktopAfterLoadWork[display] = nil
                if !self.reasons.contains(.hidden) { self.desktop.update(display, reason: "page loaded") }
            }
        }
        desktopAfterLoadWork[display] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.desktopAfterLoad, execute: work)
    }

    // Paused: nobody sees the wallpaper, so a snapshot costs nothing visible. Not when hidden (the
    // window is ordered out), not while a page-load update is still due, at most every 120 s.
    private func desktopWhilePaused() {
        guard settings.matchDesktop, !reasons.contains(.hidden) else { return }
        if let last = lastPausedDesktop, Date().timeIntervalSince(last) < Self.desktopWhilePausedEvery { return }
        let due = webViews.keys.filter { desktopAfterLoadWork[$0] == nil }
        guard !due.isEmpty else { return }
        lastPausedDesktop = Date()
        for display in due { desktop.update(display, reason: stateText) }
    }

    private func updateDesktopEverywhere(reason: String) {
        guard settings.matchDesktop, !reasons.contains(.hidden) else { return }
        for display in webViews.keys { desktop.update(display, reason: reason) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        log("page failed to load: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log("page failed: \(error.localizedDescription)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log("WebContent process ended; reloading the page")
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
        window.backgroundColor = .black
        window.hasShadow = false
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none

        let webView = Self.makeWebView(size: screen.frame.size, messages: MessageProxy(self))
        webView.navigationDelegate = self
        window.contentView = webView
        window.setFrame(screen.frame, display: false)
        if !reasons.contains(.hidden) { window.orderFront(nil) }

        windows[display] = window
        webViews[display] = webView
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
        let covered = windows.keys.allSatisfy { !reported[$0]! || (shares[$0] ?? 0) >= Self.coveredShare }
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
            MainActor.assumeIsolated { self?.updateDesktopEverywhere(reason: "Space changed") }
        }
        // `pkill -USR1 KilnWall` toggles show/hide; TERM and INT quit cleanly so the feed child dies too.
        onSignal(SIGUSR1) { $0.toggleShown() }
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

    private func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let image = NSImage(systemSymbolName: "chart.xyaxis.line", accessibilityDescription: "KilnWall") {
            item.button?.image = image
        } else {
            item.button?.title = "◫"
        }
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        stateItem = menu.addItem(withTitle: "", action: nil, keyEquivalent: "")
        stateItem?.isEnabled = false
        feedItem = menu.addItem(withTitle: "", action: nil, keyEquivalent: "")
        feedItem?.isEnabled = false
        menu.addItem(.separator())
        showItem = menu.addItem(withTitle: "Hide Wallpaper", action: #selector(toggleShown), keyEquivalent: "")
        pauseItem = menu.addItem(withTitle: "Pause", action: #selector(togglePause), keyEquivalent: "")
        menu.addItem(.separator())
        designMenu = NSMenu()
        designMenu?.autoenablesItems = false
        designMenuItem = menu.addItem(withTitle: "Design", action: nil, keyEquivalent: "")
        designMenuItem?.submenu = designMenu
        refreshMenu = NSMenu()
        refreshMenu?.autoenablesItems = false
        refreshMenuItem = menu.addItem(withTitle: "Refresh", action: nil, keyEquivalent: "")
        refreshMenuItem?.submenu = refreshMenu
        matchItem = menu.addItem(withTitle: "Match macOS Wallpaper", action: #selector(toggleMatchDesktop), keyEquivalent: "")
        menu.addItem(withTitle: "Reload Page", action: #selector(reloadPage), keyEquivalent: "")
        menu.addItem(withTitle: "Open Page Folder", action: #selector(openPageFolder), keyEquivalent: "")
        menu.addItem(.separator())
        loginItem = menu.addItem(withTitle: "Launch at Login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit KilnWall", action: #selector(quit), keyEquivalent: "q")
        for entry in menu.items where entry.action != nil { entry.target = self }
        item.menu = menu
        statusItem = item
    }

    // The submenus are rebuilt each time the menu opens: designs come and go on disk.
    func menuNeedsUpdate(_ menu: NSMenu) {
        stateItem?.title = stateText
        feedItem?.title = feed.mode
        showItem?.title = reasons.contains(.hidden) ? "Show Wallpaper" : "Hide Wallpaper"
        pauseItem?.title = reasons.contains(.manual) ? "Resume" : "Pause"
        loginItem?.state = SMAppService.mainApp.status == .enabled ? .on : .off
        matchItem?.state = settings.matchDesktop ? .on : .off
        fillDesignMenu()
        fillRefreshMenu()
    }

    private func fillDesignMenu() {
        guard let designMenu else { return }
        designMenu.removeAllItems()
        let designs = Designs.list()
        let shown = target.design.flatMap { id in designs.first { $0.id == id }?.name }
        designMenuItem?.title = "Design: " + (shown ?? target.label)
        if designs.isEmpty {
            let empty = designMenu.addItem(withTitle: "No designs in \(Designs.root.path)", action: nil, keyEquivalent: "")
            empty.isEnabled = false
        }
        for design in designs {
            let title = design.hasPage ? design.name : "\(design.name) (no index.html yet)"
            let entry = designMenu.addItem(withTitle: title, action: #selector(chooseDesign(_:)), keyEquivalent: "")
            entry.target = self
            entry.representedObject = design.id
            entry.isEnabled = design.hasPage
            entry.state = design.id == target.design ? .on : .off
        }
    }

    private func fillRefreshMenu() {
        guard let refreshMenu else { return }
        refreshMenu.removeAllItems()
        refreshMenuItem?.title = "Refresh: \(settings.periodMs) ms"
        for ms in stride(from: Settings.minPeriod, through: Settings.maxPeriod, by: Settings.step) {
            let entry = refreshMenu.addItem(withTitle: "\(ms) ms", action: #selector(chooseRefresh(_:)), keyEquivalent: "")
            entry.target = self
            entry.tag = ms
            entry.state = ms == settings.periodMs ? .on : .off
        }
        refreshMenu.addItem(.separator())
        let faster = refreshMenu.addItem(withTitle: "Faster  ⌃⌥=", action: #selector(faster), keyEquivalent: "")
        faster.target = self
        faster.isEnabled = settings.periodMs > Settings.minPeriod
        let slower = refreshMenu.addItem(withTitle: "Slower  ⌃⌥-", action: #selector(slower), keyEquivalent: "")
        slower.target = self
        slower.isEnabled = settings.periodMs < Settings.maxPeriod
    }

    @objc private func chooseDesign(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        var next = settings
        next.design = id
        choose(next, source: "menu")
    }

    @objc private func chooseRefresh(_ sender: NSMenuItem) {
        var next = settings
        next.periodMs = Settings.clamp(sender.tag)
        choose(next, source: "menu")
    }

    @objc private func toggleMatchDesktop() {
        var next = settings
        next.matchDesktop.toggle()
        choose(next, source: "menu")
    }

    @objc private func faster() { stepPeriod(-Settings.step, source: "menu") }

    @objc private func slower() { stepPeriod(Settings.step, source: "menu") }

    @objc private func togglePause() {
        set(.manual, !reasons.contains(.manual))
    }

    @objc private func reloadPage() {
        // A design (or the old page folder) may have appeared since: pick it up.
        log("reloading the page (menu)")
        let before = target
        retarget()
        if target == before { reloadPages() }
    }

    @objc private func openPageFolder() {
        NSWorkspace.shared.open(target.index.deletingLastPathComponent())
    }

    @objc private func toggleLaunchAtLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
                log("launch at login off")
            } else {
                try SMAppService.mainApp.register()
                log("launch at login on")
            }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Couldn't change Launch at Login"
            alert.informativeText = error.localizedDescription
            NSApp.activate()
            alert.runModal()
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
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
