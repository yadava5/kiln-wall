// Where the Dock is, for the page: window.kiln.config({..., dock}) -> Kiln.dock in kiln-runtime.js.
// The request, 2026-11-05: "the dock can lengthen and shorten; if I open multiple apps, it might get
// longer … adjust the things on top and bottom when the dock lengthens, and adjust them again when
// it shortens."
//
// Per display, in that page's points with a top-left origin:
//   {side: "left"|"bottom"|"right", y0, y1, x0, x1, thickness, autohide, exact}   or null
// x0..x1 and y0..y1 are the area the Dock covers when SHOWN (an auto-hidden Dock still has a tile
// span; its hidden position is not reported). For a left Dock x0 = 0 and x1 = thickness; for a
// right one x0 = width - thickness, x1 = width; for a bottom one y0 = height - thickness, y1 =
// height and x0..x1 is the tile span. thickness = the Dock's shown width (across the screen edge)
// plus the system margin between it and the usable area.
//
// Two ways to know it:
//  - exact: KilnWall is trusted for Accessibility (AXIsProcessTrusted; never asked for here, never
//    prompted: a permission is the user's to give). The Dock app's AXList is its tile strip.
//  - estimate: otherwise, from the Dock's preferences and the running apps (see estimate()).
// CGWindowList does not list the Dock's tile window and NSScreen.visibleFrame has no inset for an
// auto-hidden Dock (both measured 2026-11-05 15:45), so these are the only two sources.
//
// Recomputed on app launch and quit, screen changes, and every `poll` seconds (Dock preference
// changes have no notification this app can rely on; the poll also catches the Dock's own tile
// animation finishing after a launch). Sent only when the value changed.
import AppKit
import ApplicationServices

struct DockInfo: Equatable {
    enum Side: String { case left, bottom, right }
    var side: Side
    var y0: Double, y1: Double, x0: Double, x1: Double
    var thickness: Double
    var autohide: Bool
    var exact: Bool

    // For the page (callAsyncJavaScript bridges NSNumber/NSString/NSDictionary/NSNull).
    var page: [String: Any] {
        ["side": side.rawValue, "y0": y0, "y1": y1, "x0": x0, "x1": x1,
         "thickness": thickness, "autohide": autohide, "exact": exact]
    }

    var description: String {
        func f(_ v: Double) -> String { v == v.rounded() ? String(Int(v)) : String(format: "%.1f", v) }
        return "\(side.rawValue) y \(f(y0))-\(f(y1)) x \(f(x0))-\(f(x1)), thickness \(f(thickness)), "
            + "\(autohide ? "auto-hides" : "always shown"), \(exact ? "exact (Accessibility)" : "estimated")"
    }
}

// The com.apple.dock preferences the estimate reads.
struct DockPrefs: Equatable {
    var orientation: DockInfo.Side = .bottom
    var tileSize: Double = 48
    var autohide = false
    var showRecents = true
    // persistent-apps, in order: a bundle id (nil for a tile without one) and the tile's size in
    // tiles (a spacer-tile counts 1, a small-spacer-tile 0.5).
    var persistentApps: [(id: String?, tiles: Double)] = []
    var persistentOthers = 0
    var recentApps: [String] = []

    static func == (a: DockPrefs, b: DockPrefs) -> Bool {
        a.orientation == b.orientation && a.tileSize == b.tileSize && a.autohide == b.autohide
            && a.showRecents == b.showRecents && a.persistentOthers == b.persistentOthers
            && a.recentApps == b.recentApps
            && a.persistentApps.map(\.id) == b.persistentApps.map(\.id)
            && a.persistentApps.map(\.tiles) == b.persistentApps.map(\.tiles)
    }

    // Read fresh each time: CFPreferencesAppSynchronize drops this process's cached copy of
    // another app's domain, so a change made in System Settings is seen on the next read.
    static func read() -> DockPrefs {
        let domain = "com.apple.dock" as CFString
        CFPreferencesAppSynchronize(domain)
        func value(_ key: String) -> Any? { CFPreferencesCopyAppValue(key as CFString, domain) }
        var prefs = DockPrefs()
        if let text = value("orientation") as? String, let side = DockInfo.Side(rawValue: text) { prefs.orientation = side }
        if let size = (value("tilesize") as? NSNumber)?.doubleValue, size > 0 { prefs.tileSize = size }
        if let on = value("autohide") as? NSNumber { prefs.autohide = on.boolValue }
        if let on = value("show-recents") as? NSNumber { prefs.showRecents = on.boolValue }
        prefs.persistentApps = ((value("persistent-apps") as? [[String: Any]]) ?? []).map { tile in
            let type = tile["tile-type"] as? String
            let id = (tile["tile-data"] as? [String: Any])?["bundle-identifier"] as? String
            return (id, type == "small-spacer-tile" ? 0.5 : 1)
        }
        prefs.persistentOthers = ((value("persistent-others") as? [Any]) ?? []).count
        prefs.recentApps = ((value("recent-apps") as? [[String: Any]]) ?? []).compactMap {
            ($0["tile-data"] as? [String: Any])?["bundle-identifier"] as? String
        }
        return prefs
    }
}

enum DockGeometry {
    // The Dock's layout at tile size 38, measured 2026-11-05 through Accessibility (left Dock,
    // 11 app tiles, 1 separator, Trash): every tile 40 pt along the strip, the separator 18 pt,
    // 2.5 + 3.5 pt at the ends, and the strip 52 pt across. The Nov 4 visibleFrame of the same
    // Dock shown (not auto-hiding) began at x = 58: a 6 pt margin past the strip. Other tile sizes
    // are scaled from these in proportion; only 38 has been measured.
    static let measuredTile = 38.0
    static let tilePitch = 40.0, separator = 18.0, ends = 6.0, across = 52.0
    static let margin = 6.0
    static let finder = "com.apple.finder"

    // Bundle ids of the running apps that have a Dock tile (regular activation policy).
    static func runningRegularApps() -> [String] {
        NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .map { $0.bundleIdentifier ?? $0.bundleURL?.path ?? "pid \($0.processIdentifier)" }
    }

    // The Dock's tiles along its strip, as tile and separator counts:
    //   Finder (always first, never in persistent-apps), persistent-apps, the running regular apps
    //   not in persistent-apps (after them with no separator while recents are hidden; with
    //   show-recents on, in their own section after a separator, together with recent-apps), then a
    //   separator, persistent-others (folders, stacks) and the Trash.
    // Not counted: minimized windows kept as their own tiles (minimize-to-application off), which
    // nothing short of Accessibility can see.
    static func count(_ prefs: DockPrefs, running: [String]) -> (tiles: Double, separators: Int) {
        let pinned = Set(prefs.persistentApps.compactMap(\.id))
        var seen = Set<String>()
        let unpinned = running.filter { $0 != finder && !pinned.contains($0) && seen.insert($0).inserted }
        var tiles = 1 + prefs.persistentApps.reduce(0) { $0 + $1.tiles }
        var separators = 0
        if prefs.showRecents {
            let recents = Set(unpinned).union(prefs.recentApps.filter { $0 != finder && !pinned.contains($0) })
            if !recents.isEmpty { separators += 1; tiles += Double(recents.count) }
        } else {
            tiles += Double(unpinned.count)
        }
        separators += 1
        tiles += Double(prefs.persistentOthers) + 1  // + Trash
        return (tiles, separators)
    }

    // The screen in top-left points relative to the primary screen (Accessibility's space).
    static func topLeftFrame(_ screen: NSScreen) -> CGRect {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? screen.frame.height
        let f = screen.frame
        return CGRect(x: f.minX, y: primaryHeight - f.maxY, width: f.width, height: f.height)
    }

    static func displayID(_ screen: NSScreen) -> CGDirectDisplayID {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    }

    static func half(_ v: Double) -> Double { (v * 2).rounded() / 2 }

    // The Dock on `screen` from a strip: `along` its span along the edge in page points (y for a
    // side Dock, x for a bottom one), `across` its shown width across the edge.
    static func info(side: DockInfo.Side, along: ClosedRange<Double>, across: Double, size: CGSize,
                     autohide: Bool, exact: Bool) -> DockInfo {
        let thickness = half(across + margin)
        switch side {
        case .left:
            return DockInfo(side: side, y0: half(along.lowerBound), y1: half(along.upperBound), x0: 0, x1: thickness,
                            thickness: thickness, autohide: autohide, exact: exact)
        case .right:
            return DockInfo(side: side, y0: half(along.lowerBound), y1: half(along.upperBound),
                            x0: half(size.width - thickness), x1: half(size.width),
                            thickness: thickness, autohide: autohide, exact: exact)
        case .bottom:
            return DockInfo(side: side, y0: half(size.height - thickness), y1: half(size.height),
                            x0: half(along.lowerBound), x1: half(along.upperBound),
                            thickness: thickness, autohide: autohide, exact: exact)
        }
    }

    // The estimate, on the screen the Dock is on (the primary one, the menu bar's, unless
    // Accessibility says otherwise). A side Dock is centred on the screen below the menu bar
    // (measured: strip 256-760, centre 508, against 32-982, centre 507); a bottom one on the
    // screen's width. The Dock shrinks its tiles to fit rather than overflow, so the strip is
    // capped at the room there is.
    static func estimate(_ prefs: DockPrefs, running: [String], screen: NSScreen) -> DockInfo {
        let k = prefs.tileSize / measuredTile
        let (tiles, separators) = count(prefs, running: running)
        let size = screen.frame.size
        let top = max(0, screen.frame.maxY - screen.visibleFrame.maxY)  // the menu bar
        let room: ClosedRange<Double> = prefs.orientation == .bottom ? 0...size.width : top...size.height
        let wanted = (ends + tiles * tilePitch + Double(separators) * separator) * k
        let length = min(wanted, room.upperBound - room.lowerBound)
        let mid = (room.lowerBound + room.upperBound) / 2
        return info(side: prefs.orientation, along: (mid - length / 2)...(mid + length / 2),
                    across: across * min(k, length / wanted), size: size, autohide: prefs.autohide, exact: false)
    }

    // The Dock's AXList frame in Accessibility's top-left global points, or nil (not trusted, no
    // Dock, or it did not answer within the timeout).
    static func accessibilityStrip() -> CGRect? {
        guard AXIsProcessTrusted(),
              let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first
        else { return nil }
        let app = AXUIElementCreateApplication(dock.processIdentifier)
        AXUIElementSetMessagingTimeout(app, 0.25)
        func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
            var value: CFTypeRef?
            return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
        }
        guard let children = attribute(app, kAXChildrenAttribute) as? [AXUIElement] else { return nil }
        for child in children where (attribute(child, kAXRoleAttribute) as? String) == "AXList" {
            var origin = CGPoint.zero, size = CGSize.zero
            guard let p = attribute(child, kAXPositionAttribute), let s = attribute(child, kAXSizeAttribute),
                  CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID(),
                  AXValueGetValue(p as! AXValue, .cgPoint, &origin), AXValueGetValue(s as! AXValue, .cgSize, &size),
                  size.width > 0, size.height > 0
            else { continue }
            return CGRect(origin: origin, size: size)
        }
        return nil
    }

    // The exact reading: the screen whose edge the strip sits on, and the Dock on it. An
    // auto-hidden strip sits just past that edge (x = -52 for a left Dock), so the screen is the
    // one spanning the strip's centre along the edge whose edge is nearest.
    static func exact(_ strip: CGRect, prefs: DockPrefs) -> (CGDirectDisplayID, DockInfo)? {
        let side: DockInfo.Side = strip.width > strip.height ? .bottom : (prefs.orientation == .right ? .right : .left)
        let candidates = NSScreen.screens.map { ($0, topLeftFrame($0)) }.filter { _, f in
            side == .bottom ? (f.minX...f.maxX).contains(strip.midX) : (f.minY...f.maxY).contains(strip.midY)
        }
        func gap(_ f: CGRect) -> Double {
            switch side {
            case .left: return min(abs(f.minX - strip.minX), abs(f.minX - strip.maxX))
            case .right: return min(abs(f.maxX - strip.minX), abs(f.maxX - strip.maxX))
            case .bottom: return min(abs(f.maxY - strip.minY), abs(f.maxY - strip.maxY))
            }
        }
        guard let (screen, f) = candidates.min(by: { gap($0.1) < gap($1.1) }) else { return nil }
        let along: ClosedRange<Double> = side == .bottom
            ? Double(strip.minX - f.minX)...Double(strip.maxX - f.minX)
            : Double(strip.minY - f.minY)...Double(strip.maxY - f.minY)
        let across = Double(side == .bottom ? strip.height : strip.width)
        return (displayID(screen), info(side: side, along: along, across: across, size: f.size,
                                       autohide: prefs.autohide, exact: true))
    }
}

// Keeps the Dock's geometry for every display and says when it changes.
@MainActor
final class DockWatcher {
    // A launch or quit: read once things settle, and again once the Dock's tile animation has
    // finished (the strip grows over about half a second).
    static let debounce: TimeInterval = 0.3
    static let settle: TimeInterval = 1.0
    static let poll: TimeInterval = 5

    private(set) var current: [CGDirectDisplayID: DockInfo] = [:]
    // (new geometry, why). Called only when it differs from `current`.
    var onChange: (([CGDirectDisplayID: DockInfo], String) -> Void)?
    // Seams for a test harness: the running apps, and whether Accessibility may be used.
    var runningApps: () -> [String] = DockGeometry.runningRegularApps
    var useAccessibility = true
    private(set) var recomputes = 0
    private var observers: [NSObjectProtocol] = []
    private var timer: Timer?
    private var pending: DispatchWorkItem?
    private var settleWork: DispatchWorkItem?
    private var lastPath: Bool?

    func start() {
        let workspace = NSWorkspace.shared.notificationCenter
        for (name, why) in [(NSWorkspace.didLaunchApplicationNotification, "app launched"),
                            (NSWorkspace.didTerminateApplicationNotification, "app quit")] {
            observers.append(workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                let what = "\(why): \(app?.bundleIdentifier ?? app?.localizedName ?? "?")"
                MainActor.assumeIsolated { self?.schedule(what) }
            })
        }
        observers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.schedule("screens changed") }
        })
        let timer = Timer(timeInterval: Self.poll, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.recompute("poll") }
        }
        timer.tolerance = 1
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        recompute("start")
    }

    func stop() {
        for observer in observers {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            NotificationCenter.default.removeObserver(observer)
        }
        observers = []
        timer?.invalidate()
        timer = nil
        pending?.cancel()
        settleWork?.cancel()
    }

    // Debounced: a burst of launches is one read, plus one more once the Dock has settled.
    func schedule(_ why: String) {
        pending?.cancel()
        settleWork?.cancel()
        let now = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.recompute(why) } }
        let later = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.recompute(why + ", settled") } }
        pending = now
        settleWork = later
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.debounce, execute: now)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.settle, execute: later)
    }

    func recompute(_ why: String) {
        recomputes += 1
        let next = read()
        guard next != current else { return }
        current = next
        onChange?(next, why)
    }

    // Every display gets an entry only if the Dock is on it.
    func read() -> [CGDirectDisplayID: DockInfo] {
        let prefs = DockPrefs.read()
        let strip = useAccessibility ? DockGeometry.accessibilityStrip() : nil
        let exact = strip.flatMap { DockGeometry.exact($0, prefs: prefs) }
        if lastPath != (exact != nil) {
            lastPath = exact != nil
            log("dock: " + (exact != nil
                ? "exact, from the Dock's Accessibility strip"
                : "estimated from com.apple.dock and the running apps (Accessibility "
                    + (!useAccessibility ? "not used" : AXIsProcessTrusted() ? "trusted but the Dock did not answer" : "not granted to KilnWall") + ")"))
        }
        if let (display, info) = exact { return [display: info] }
        guard let screen = NSScreen.screens.first else { return [:] }
        return [DockGeometry.displayID(screen): DockGeometry.estimate(prefs, running: runningApps(), screen: screen)]
    }
}
