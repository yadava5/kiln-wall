// KilnWall — a local HTML dashboard as the desktop wallpaper, fed live JSON.
//
// One borderless window per screen sits one level below the desktop icons (so above LiveWall's
// video, which sits at the desktop level) and holds a WKWebView showing page/index.html. Each JSON
// line from the feed (Feed.swift) is handed to the page as window.kiln.update(data). Whenever
// nobody can see the wallpaper the feed is stopped and the page is told window.kiln.pause().
import AppKit
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

    static let userPageFolder = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".config/kiln-wall/page", isDirectory: true)

    private var windows: [CGDirectDisplayID: NSWindow] = [:]
    private var webViews: [CGDirectDisplayID: WKWebView] = [:]
    private var reasons: Set<PauseReason> = []
    private var running = false  // feed on and page told to animate
    private var coverageTimer: Timer?
    private var pageFolder = KilnWall.resolvePageFolder()
    private var watcher: FolderWatcher?
    private var reloadWork: DispatchWorkItem?
    private var signals: [DispatchSourceSignal] = []
    private var statusItem: NSStatusItem?
    private var stateItem: NSMenuItem?
    private var feedItem: NSMenuItem?
    private var showItem: NSMenuItem?
    private var pauseItem: NSMenuItem?
    private var loginItem: NSMenuItem?
    private let feed = Feed()
    private var acknowledged = 0
    private var scriptErrors = 0
    // kiln-feed sends `analytics` only on lines where it changed. A page that loads after that
    // line (launch race, live reload, WebContent restart) gets this replayed on load.
    private var lastAnalytics: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        log("started; page folder \(pageFolder.path)")
        feed.onJSON = { [weak self] json in self?.push(json) }
        buildStatusItem()
        watchPageFolder()
        watchSystem()
        syncWindows()
        refreshLowPower()
        apply()
    }

    func applicationWillTerminate(_ notification: Notification) {
        feed.stop()
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

    // MARK: Page

    static func resolvePageFolder() -> URL {
        var isFolder: ObjCBool = false
        if FileManager.default.fileExists(atPath: userPageFolder.path, isDirectory: &isFolder), isFolder.boolValue {
            return userPageFolder
        }
        return Bundle.main.resourceURL!.appendingPathComponent("page", isDirectory: true)
    }

    // The next three are shared with the headless modes (Headless.swift), so a snapshot loads and
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

    static func loadPage(_ webView: WKWebView, from folder: URL) {
        webView.loadFileURL(folder.appendingPathComponent("index.html"), allowingReadAccessTo: folder)
    }

    // Data for the page: the parsed JSON object, passed as a real JS object (no string building).
    static func send(_ json: [String: Any], to webView: WKWebView, onError: @escaping (Error) -> Void) {
        webView.callAsyncJavaScript(
            "window.kiln && window.kiln.update(data)", arguments: ["data": json], in: nil, in: .page
        ) { result in
            if case .failure(let error) = result { onError(error) }
        }
    }

    private func load(_ webView: WKWebView) {
        Self.loadPage(webView, from: pageFolder)
    }

    private func watchPageFolder() {
        watcher = FolderWatcher(pageFolder) { [weak self] in self?.pageFilesChanged() }
    }

    // Editors save in bursts (temp file, rename, attributes): one reload per burst.
    private func pageFilesChanged() {
        reloadWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.reloadWork = nil
                log("page files changed; reloading")
                self?.reloadPages()
            }
        }
        reloadWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.reloadDebounce, execute: work)
    }

    private func reloadPages() {
        for webView in webViews.values { load(webView) }
    }

    private func push(_ json: [String: Any]) {
        if let analytics = json["analytics"] { lastAnalytics = analytics }
        for webView in webViews.values {
            Self.send(json, to: webView) { [weak self] error in self?.scriptFailed(error) }
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
        // A partial update: the page merges it with the next full line.
        if let analytics = lastAnalytics {
            Self.send(["replay": true, "analytics": analytics], to: webView) { [weak self] error in
                self?.scriptFailed(error)
            }
        }
        if !running {
            webView.callAsyncJavaScript(
                "window.kiln && window.kiln.pause && window.kiln.pause()", arguments: [:], in: nil, in: .page)
        }
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

    func menuNeedsUpdate(_ menu: NSMenu) {
        stateItem?.title = stateText
        feedItem?.title = feed.mode
        showItem?.title = reasons.contains(.hidden) ? "Show Wallpaper" : "Hide Wallpaper"
        pauseItem?.title = reasons.contains(.manual) ? "Resume" : "Pause"
        loginItem?.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    @objc private func togglePause() {
        set(.manual, !reasons.contains(.manual))
    }

    @objc private func reloadPage() {
        // The user folder may have been created since launch: pick it up.
        let folder = Self.resolvePageFolder()
        if folder != pageFolder {
            pageFolder = folder
            watchPageFolder()
            log("page folder is now \(folder.path)")
        }
        log("reloading the page (menu)")
        reloadPages()
    }

    @objc private func openPageFolder() {
        NSWorkspace.shared.open(pageFolder)
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

// FSEvents on a folder (recursive, file-level), delivered on the main queue.
@MainActor
final class FolderWatcher {
    private var stream: FSEventStreamRef?
    private let onChange: () -> Void

    init(_ folder: URL, onChange: @escaping () -> Void) {
        self.onChange = onChange
        var context = FSEventStreamContext(
            version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, _, _, _, _ in
            guard let info else { return }
            let watcher = Unmanaged<FolderWatcher>.fromOpaque(info).takeUnretainedValue()
            MainActor.assumeIsolated { watcher.onChange() }
        }
        guard let stream = FSEventStreamCreate(
            nil, callback, &context, [folder.path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.05,
            FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer))
        else {
            log("cannot watch \(folder.path)")
            return
        }
        FSEventStreamSetDispatchQueue(stream, .main)
        FSEventStreamStart(stream)
        self.stream = stream
        log("watching \(folder.path) for changes")
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
