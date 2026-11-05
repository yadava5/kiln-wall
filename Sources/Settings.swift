// What the user picked (settings.json), which designs exist (designs/), and which page that
// resolves to. Shared by the wallpaper (main.swift), the headless modes (Headless.swift) and,
// for the file format, the `kiln-wall` CLI in ~/.local/bin.
import Darwin
import Foundation

// ~/.config/kiln-wall/settings.json: {"design": "<folder id>", "period_ms": <100..1000>}.
// Every writer (this app, the kiln-wall CLI) writes it atomically, temp file + rename.
struct Settings: Equatable {
    static let minPeriod = 100
    static let maxPeriod = 1000
    static let step = 100
    static let defaults = Settings(design: "glass", periodMs: 300)

    static let folder = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".config/kiln-wall", isDirectory: true)
    static let file = folder.appendingPathComponent("settings.json")

    var design: String
    var periodMs: Int

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
        if !problems.isEmpty {
            log("settings: \(problems.joined(separator: "; ")); using design \(result.design), period \(result.periodMs) ms")
        }
        return result
    }

    // Keeps any other keys in the file. Same layout as the CLI's json.dumps.
    func write() throws {
        var others: [String: Any] = [:]
        if let data = try? Data(contentsOf: Self.file),
           let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            others = object
            others["design"] = nil
            others["period_ms"] = nil
        }
        var text = "{\"design\": \(Self.fragment(design)), \"period_ms\": \(periodMs)"
        for key in others.keys.sorted() { text += ", \(Self.fragment(key)): \(Self.fragment(others[key]!))" }
        text += "}\n"
        try FileManager.default.createDirectory(at: Self.folder, withIntermediateDirectories: true)
        try Data(text.utf8).write(to: Self.file, options: .atomic)
    }

    private static func fragment(_ value: Any) -> String {
        let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])
        return data.map { String(decoding: $0, as: UTF8.self) } ?? "null"
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

// kiln-feed sends `analytics`, `github` and `hist` only on lines where they changed. A page that
// loads after such a line (launch race, live reload, design switch, WebContent restart) gets the
// last of each replayed as one line: {"replay": true, ...}.
struct ReplayCache {
    static let keys = ["analytics", "github", "hist"]
    private(set) var blocks: [String: Any] = [:]

    mutating func note(_ json: [String: Any]) {
        for key in Self.keys { if let value = json[key] { blocks[key] = value } }
    }

    var line: [String: Any]? {
        blocks.isEmpty ? nil : blocks.merging(["replay": true]) { kept, _ in kept }
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
