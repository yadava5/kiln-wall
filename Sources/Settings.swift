// What the user picked (settings.json), which designs exist (designs/), and which page that
// resolves to. Shared by the wallpaper (main.swift), the headless modes (Headless.swift) and,
// for the file format, the `kiln-wall` CLI in ~/.local/bin.
import Darwin
import Foundation

// ~/.config/kiln-wall/settings.json: {"design": "<folder id>", "period_ms": <100..1000>,
// "match_desktop": <bool, default true>}, plus "original_desktop" (see OriginalDesktop), which is
// state the app keeps, not a choice. Every writer (this app, the kiln-wall CLI) writes it
// atomically, temp file + rename, and keeps the keys it does not know.
struct Settings: Equatable {
    static let minPeriod = 100
    static let maxPeriod = 1000
    static let step = 100
    static let defaults = Settings(design: "glass", periodMs: 300, matchDesktop: true)

    static let folder = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".config/kiln-wall", isDirectory: true)
    static let file = folder.appendingPathComponent("settings.json")

    var design: String
    var periodMs: Int
    // Keep the macOS desktop picture matched to the wallpaper (DesktopMatcher, Desktop.swift).
    var matchDesktop: Bool

    static func clamp(_ ms: Int) -> Int { min(maxPeriod, max(minPeriod, ms)) }

    // At launch: never fails; anything missing or invalid is the default.
    static func load() -> Settings {
        guard let data = try? Data(contentsOf: file) else {
            log("settings: no \(file.path); using design \(defaults.design), period \(defaults.periodMs) ms")
            return defaults
        }
        guard let read = parse(data, over: defaults) else {
            log("settings: \(file.path) is not a JSON object; using the defaults")
            return defaults
        }
        return read
    }

    // On a later change: nil if the file is unreadable (keep what is running), otherwise the file's
    // valid fields over `base`.
    static func reread(over base: Settings) -> Settings? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return parse(data, over: base)
    }

    private static func parse(_ data: Data, over base: Settings) -> Settings? {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        var result = base
        var problems: [String] = []
        if let design = object["design"] as? String, Designs.isValidID(design) {
            result.design = design
        } else {
            problems.append("design \(object["design"].map { "\($0)" } ?? "missing")")
        }
        if let number = object["period_ms"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
           number.doubleValue.isFinite {
            let ms = Int(number.doubleValue.rounded())
            result.periodMs = clamp(ms)
            if result.periodMs != ms { problems.append("period_ms \(ms) clamped to \(result.periodMs)") }
        } else {
            problems.append("period_ms \(object["period_ms"].map { "\($0)" } ?? "missing")")
        }
        // Optional (files from before it existed lack it): missing is the default, not a problem.
        if let value = object["match_desktop"] {
            if let flag = value as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() {
                result.matchDesktop = flag.boolValue
            } else {
                problems.append("match_desktop \(value) is not true or false")
            }
        } else {
            result.matchDesktop = defaults.matchDesktop
        }
        if !problems.isEmpty {
            log("settings: \(problems.joined(separator: "; ")); using design \(result.design), period \(result.periodMs) ms, match desktop \(result.matchDesktop)")
        }
        return result
    }

    func write() throws {
        try Self.rewrite { object in
            object["design"] = design
            object["period_ms"] = periodMs
            object["match_desktop"] = matchDesktop
        }
    }

    // Read, change, write back, keeping every key it does not touch. Same layout as the CLI's
    // json.dumps: design and period_ms first, the rest sorted.
    static func rewrite(_ change: (inout [String: Any]) -> Void) throws {
        var object: [String: Any] = [:]
        if let data = try? Data(contentsOf: file),
           let read = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            object = read
        }
        change(&object)
        let first = ["design", "period_ms"].filter { object[$0] != nil }
        let rest = object.keys.filter { !first.contains($0) }.sorted()
        let text = "{" + (first + rest).map { "\(fragment($0)): \(fragment(object[$0]!))" }.joined(separator: ", ") + "}\n"
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file, options: .atomic)
    }

    private static func fragment(_ value: Any) -> String {
        let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])
        return data.map { String(decoding: $0, as: UTF8.self) } ?? "null"
    }
}

// The user's own desktop picture, saved before KilnWall first replaces it on a display and put
// back on Quit or when matching is switched off: "original_desktop" in settings.json, keyed by
// the display's UUID (stable across reboots and reconnection, unlike its CGDirectDisplayID):
//   {"<uuid>": {"display": "Built-in Retina Display", "url": "file:///...", "scaling": 3,
//               "allow_clipping": true, "fill_color": [r, g, b, a]}}
// The options are NSWorkspace's desktop image options as plain values (fill_color in calibrated
// RGB); Desktop.swift converts them.
struct OriginalDesktop: Equatable {
    static let key = "original_desktop"

    var display: String
    var url: URL
    var scaling: Int?
    var allowClipping: Bool?
    var fillColor: [Double]?

    init(display: String, url: URL, scaling: Int?, allowClipping: Bool?, fillColor: [Double]?) {
        self.display = display
        self.url = url
        self.scaling = scaling
        self.allowClipping = allowClipping
        self.fillColor = fillColor
    }

    init?(json: Any) {
        guard let object = json as? [String: Any], let text = object["url"] as? String,
              let url = URL(string: text) else { return nil }
        self.url = url
        display = object["display"] as? String ?? ""
        scaling = (object["scaling"] as? NSNumber)?.intValue
        allowClipping = (object["allow_clipping"] as? NSNumber)?.boolValue
        fillColor = (object["fill_color"] as? [NSNumber])?.map(\.doubleValue)
    }

    var json: [String: Any] {
        var object: [String: Any] = ["display": display, "url": url.absoluteString]
        if let scaling { object["scaling"] = scaling }
        if let allowClipping { object["allow_clipping"] = allowClipping }
        if let fillColor { object["fill_color"] = fillColor }
        return object
    }

    static func loadAll() -> [String: OriginalDesktop] {
        guard let data = try? Data(contentsOf: Settings.file),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let saved = object[key] as? [String: Any]
        else { return [:] }
        return saved.compactMapValues { OriginalDesktop(json: $0) }
    }

    // None left: the key is removed.
    static func saveAll(_ all: [String: OriginalDesktop]) throws {
        try Settings.rewrite { object in
            object[key] = all.isEmpty ? nil : all.mapValues(\.json)
        }
    }
}

// One design: a folder of designs/ whose name does not start with "_".
struct Design {
    let id: String
    let name: String
    let order: Double
    let hasPage: Bool
}

enum Designs {
    // KILN_DESIGNS_DIR overrides it, for testing.
    static var root: URL {
        if let path = ProcessInfo.processInfo.environment["KILN_DESIGNS_DIR"], !path.isEmpty {
            return URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
        }
        return Settings.folder.appendingPathComponent("designs", isDirectory: true)
    }

    static func isValidID(_ id: String) -> Bool {
        !id.isEmpty && !id.hasPrefix("_") && !id.hasPrefix(".") && !id.contains("/")
    }

    static func index(of id: String, in root: URL = root) -> URL {
        root.appendingPathComponent(id, isDirectory: true).appendingPathComponent("index.html")
    }

    static func hasPage(_ id: String, in root: URL = root) -> Bool {
        isValidID(id) && FileManager.default.fileExists(atPath: index(of: id, in: root).path)
    }

    // Sorted by design.json "order" (none: last), then id.
    static func list(in root: URL = root) -> [Design] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        let designs: [Design] = names.compactMap { id in
            var isFolder: ObjCBool = false
            let folder = root.appendingPathComponent(id, isDirectory: true)
            guard isValidID(id), FileManager.default.fileExists(atPath: folder.path, isDirectory: &isFolder),
                  isFolder.boolValue
            else { return nil }
            let meta = (try? Data(contentsOf: folder.appendingPathComponent("design.json")))
                .flatMap { (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any] } ?? [:]
            let name = (meta["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? id
            let order = (meta["order"] as? NSNumber)?.doubleValue ?? .infinity
            return Design(id: id, name: name, order: order, hasPage: hasPage(id, in: root))
        }
        return designs.sorted { ($0.order, $0.id) < ($1.order, $1.id) }
    }
}

// The page to show and the folder WebKit may read for it.
struct PageTarget: Equatable {
    let index: URL
    let readAccess: URL
    let design: String?  // nil: the old single page folder or the bundled page
    let label: String

    static let userPageFolder = Settings.folder.appendingPathComponent("page", isDirectory: true)

    static func design(_ id: String, in root: URL = Designs.root) -> PageTarget {
        PageTarget(index: Designs.index(of: id, in: root), readAccess: root, design: id, label: "design \(id)")
    }

    // The chosen design; else the first design alphabetically; else ~/.config/kiln-wall/page;
    // else the page bundled in the app.
    static func resolve(_ wanted: String) -> PageTarget {
        let root = Designs.root
        if Designs.hasPage(wanted, in: root) { return design(wanted, in: root) }
        let fallback = Designs.list(in: root).filter(\.hasPage).map(\.id).sorted().first
        let target: PageTarget
        if let fallback {
            target = design(fallback, in: root)
        } else if FileManager.default.fileExists(atPath: userPageFolder.appendingPathComponent("index.html").path) {
            target = PageTarget(index: userPageFolder.appendingPathComponent("index.html"), readAccess: userPageFolder,
                                design: nil, label: "page folder \(userPageFolder.path)")
        } else {
            let bundled = Bundle.main.resourceURL!.appendingPathComponent("page", isDirectory: true)
            target = PageTarget(index: bundled.appendingPathComponent("index.html"), readAccess: bundled,
                                design: nil, label: "bundled page")
        }
        return target
    }
}

// kiln-feed sends the top-level `analytics`, `github`, `hist` and `weather`, and `claude.events`,
// `claude.limits` and `claude.tokens`, only on lines where they changed. A page that loads after
// such a line (launch race, live reload, design switch, WebContent restart) gets the last of each
// inside `latest` (below); before any full line has been seen, as a replay line,
// {"replay": true, "analytics": ..., "claude": {"events": ...}, ...}, with only the blocks seen so far.
//
// Lines go to the page as raw text, so this is the only place the host reads one. It parses only
// a line that names one of the keys (`"<key>":`, as kiln-feed's compact json.dumps writes it):
// measured 2026-11-04 on 148 real lines at 100 ms (median 5.4 KB), the byte scan costs 4.5 µs a
// line against 60 µs for JSONSerialization, and 17 of the 148 named a key (all of them for real).
// A key named elsewhere in a line only costs a parse; the blocks are read from where they belong.
//
// It also keeps the last line itself (a reference, no copy or parse), so a page that loads, or
// one that was not sent the lines of a covered spell, is given the whole latest state at once:
// `latest`, the last line with every held block it lacks filled in, as a NORMAL line (no
// `replay`), which the runtime renders straight away. A design reads "now" from its `t`, so the
// figures show their real, slightly stale time until the live feed takes over.
struct ReplayCache {
    static let topKeys = ["analytics", "github", "hist", "weather"]
    static let claudeKeys = ["events", "limits", "tokens"]
    private static let patterns: [[UInt8]] = (topKeys + claudeKeys).map { Array("\($0)\":".utf8) }

    private var top: [String: Any] = [:]
    private var claude: [String: Any] = [:]
    private var last: String?

    // What a replay would carry, for the logs: "analytics, ..., claude.events, ...".
    var held: String {
        (Self.topKeys.filter { top[$0] != nil } + Self.claudeKeys.filter { claude[$0] != nil }.map { "claude." + $0 })
            .joined(separator: ", ")
    }

    mutating func note(_ line: String) {
        last = line
        guard Self.namesAKey(line),
              let json = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
        else { return }
        for key in Self.topKeys { if let value = json[key] { top[key] = value } }
        if let inner = json["claude"] as? [String: Any] {
            for key in Self.claudeKeys { if let value = inner[key] { claude[key] = value } }
        }
    }

    var line: String? {
        if top.isEmpty, claude.isEmpty { return nil }
        var object = top
        if !claude.isEmpty { object["claude"] = claude }
        object["replay"] = true
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    // The latest complete state as a normal line, and its `t` (for the logs). Without a last line
    // yet (or one that does not parse), the replay line. Parses and re-encodes one line: only on a
    // page load or an uncover, never per line.
    func latest() -> (line: String, t: Double?)? {
        guard let last,
              var object = (try? JSONSerialization.jsonObject(with: Data(last.utf8))) as? [String: Any]
        else { return line.map { ($0, nil) } }
        for (key, value) in top where object[key] == nil { object[key] = value }
        if !claude.isEmpty {
            var inner = object["claude"] as? [String: Any] ?? [:]
            for (key, value) in claude where inner[key] == nil { inner[key] = value }
            object["claude"] = inner
        }
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return (last, nil) }
        return (String(decoding: data, as: UTF8.self), (object["t"] as? NSNumber)?.doubleValue)
    }

    // Whether a `"` in the line opens one of `"<key>":`.
    static func namesAKey(_ line: String) -> Bool {
        var line = line
        return line.withUTF8 { bytes in
            let n = bytes.count
            var i = 0
            while i < n {
                if bytes[i] == 0x22 {
                    let start = i + 1
                    for pattern in patterns where start + pattern.count <= n && bytes[start] == pattern[0] {
                        var j = 1
                        while j < pattern.count, bytes[start + j] == pattern[j] { j += 1 }
                        if j == pattern.count { return true }
                    }
                }
                i += 1
            }
            return false
        }
    }
}

// The canonical path (symlinks resolved, /tmp -> /private/tmp), as FSEvents reports paths.
// URL.resolvingSymlinksInPath strips /private instead, so it cannot be used for this.
func canonicalPath(_ url: URL) -> String {
    guard let resolved = realpath(url.path, nil) else { return url.standardizedFileURL.path }
    defer { free(resolved) }
    return String(cString: resolved)
}

// Watches settings.json for any writer: the folder (catches the rename of an atomic write, and
// the file being created or deleted) and the file itself (catches an in-place write). The file
// source is re-opened after every event, since an atomic write replaces the file's inode.
@MainActor
final class SettingsWatcher {
    private static let debounce: TimeInterval = 0.05
    private var folderSource: DispatchSourceFileSystemObject?
    private var fileSource: DispatchSourceFileSystemObject?
    private var work: DispatchWorkItem?
    private let onChange: () -> Void

    init(onChange: @escaping () -> Void) {
        self.onChange = onChange
        folderSource = Self.source(Settings.folder.path, [.write, .rename, .delete]) { [weak self] in self?.changed() }
        if folderSource == nil { log("settings: cannot watch \(Settings.folder.path)") }
        watchFile()
        log("watching \(Settings.file.path) for changes")
    }

    deinit {
        folderSource?.cancel()
        fileSource?.cancel()
    }

    private func watchFile() {
        fileSource?.cancel()
        fileSource = Self.source(Settings.file.path, [.write, .extend, .delete, .rename, .attrib]) { [weak self] in
            self?.changed()
        }
    }

    private func changed() {
        watchFile()
        work?.cancel()
        let next = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.work = nil
                self?.onChange()
            }
        }
        work = next
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.debounce, execute: next)
    }

    private static func source(
        _ path: String, _ mask: DispatchSource.FileSystemEvent, _ handler: @escaping @MainActor () -> Void
    ) -> DispatchSourceFileSystemObject? {
        let fd = open(path, O_EVTONLY)
        guard fd >= 0 else { return nil }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: mask, queue: .main)
        source.setEventHandler { MainActor.assumeIsolated { handler() } }
        source.setCancelHandler { close(fd) }
        source.resume()
        return source
    }
}
