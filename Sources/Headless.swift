// Headless modes, for working on the page without seeing the desktop (from a full-screen Space,
// screencapture shows the terminal, not the wallpaper). Run the binary itself, not `open`, to get
// its output:
//
//   KilnWall --snapshot out.png [--after 8] [--frames 3 --every 1] [--size 1512x982] [--scale 2]
//            [--design glass] [--period-ms 300] [--fixture lines.jsonl]
//   KilnWall --measure 20 [--size 1512x982] [--design glass] [--period-ms 300] [--fixture lines.jsonl]
//
// No menu-bar item, no wallpaper windows, no page-folder or settings watcher, no hotkeys and no
// instance check, so a running KilnWall is left alone; settings.json is read, never written. The
// page is loaded and fed exactly as the wallpaper does it (same page resolution, same web view
// setup, same window.kiln.config / update calls, the same replay when the page reloads itself),
// in a window that WebKit treats as visible but nobody can see (see makeWindow).
import AppKit
import Darwin
import ImageIO
import WebKit

struct HeadlessOptions {
    struct UsageError: Error, CustomStringConvertible {
        let description: String
    }

    static let usage = """
        usage: KilnWall                (no arguments: the wallpaper; launch it with `open`)
               KilnWall --snapshot <out.png> [--after <s>] [--frames <n> --every <s>]
                        [--size <WxH>] [--scale 1|2] [--design <id>] [--period-ms <ms>]
                        [--fixture <file.jsonl>]
               KilnWall --measure <s> [--size <WxH>] [--design <id>] [--period-ms <ms>]
                        [--fixture <file.jsonl>]

          --snapshot  write a PNG of the page --after seconds (default 8) after it loads; with
                      --frames n, write <out>-01.png ... <out>-n.png, --every seconds apart (default 1)
          --measure   run the page for that many seconds and print the CPU time it cost
          --size      window size in points (default: the main screen's frame size)
          --scale     PNG pixels per point, 1 or 2 (default 2)
          --design    the design folder to show, from the designs folder ($KILN_DESIGNS_DIR or
                      ~/.config/kiln-wall/designs); default: settings.json's, with the wallpaper's
                      fallbacks
          --period-ms the live feed's period, 100 to 1000 ms (default: settings.json's)
          --fixture   replay this file's JSON lines at 1 Hz, looping, instead of kiln-feed.py
          -h, --help  print this and exit
        """

    var output: String?
    var measure: Double?
    var after: Double = 8
    var frames = 1
    var every: Double = 1
    var size: NSSize?
    var scale = 2
    var fixture: String?
    var design: String?
    var periodMs: Int?

    // nil: not a headless run (the wallpaper).
    static func parse(_ arguments: [String]) throws -> HeadlessOptions? {
        let args = Array(arguments.dropFirst())
        guard args.contains("--snapshot") || args.contains("--measure") else { return nil }
        var options = HeadlessOptions()
        var seen: Set<String> = []
        var i = 0
        func value(_ flag: String) throws -> String {
            i += 1
            guard i < args.count else { throw UsageError(description: "\(flag) needs a value") }
            return args[i]
        }
        func number(_ flag: String, atLeast minimum: Double) throws -> Double {
            let text = try value(flag)
            guard let n = Double(text), n.isFinite, n >= minimum else {
                throw UsageError(description: "\(flag) \(text): expected a number of at least \(minimum)")
            }
            return n
        }
        while i < args.count {
            let flag = args[i]
            guard seen.insert(flag).inserted else { throw UsageError(description: "\(flag) given twice") }
            switch flag {
            case "--snapshot": options.output = try value(flag)
            case "--measure": options.measure = try number(flag, atLeast: 1)
            case "--after": options.after = try number(flag, atLeast: 0)
            case "--every": options.every = try number(flag, atLeast: 0.05)
            case "--frames":
                let n = try number(flag, atLeast: 1)
                guard n == n.rounded(), n <= 999 else { throw UsageError(description: "--frames: a whole number, 1 to 999") }
                options.frames = Int(n)
            case "--size":
                let text = try value(flag)
                let parts = text.lowercased().split(separator: "x").compactMap { Double($0) }
                guard parts.count == 2, parts.allSatisfy({ $0 >= 1 && $0 <= 16384 }) else {
                    throw UsageError(description: "--size \(text): expected WxH in points, e.g. 1512x982")
                }
                options.size = NSSize(width: parts[0], height: parts[1])
            case "--scale":
                let text = try value(flag)
                guard let n = Int(text), n == 1 || n == 2 else { throw UsageError(description: "--scale: 1 or 2") }
                options.scale = n
            case "--fixture": options.fixture = try value(flag)
            case "--design":
                let id = try value(flag)
                guard Designs.hasPage(id) else {
                    let known = Designs.list().filter(\.hasPage).map(\.id)
                    // An existing _smoke/index.html must not read as missing: _ folders are skipped on purpose.
                    let why = id.hasPrefix("_") ? "folders starting with _ are not designs"
                        : !Designs.isValidID(id) ? "not a design folder name"
                        : "no \(Designs.index(of: id).path)"
                    throw UsageError(description: "--design \(id): \(why)"
                        + " (designs: \(known.isEmpty ? "none" : known.joined(separator: ", ")))")
                }
                options.design = id
            case "--period-ms":
                let n = try number(flag, atLeast: Double(Settings.minPeriod))
                guard n == n.rounded(), n <= Double(Settings.maxPeriod) else {
                    throw UsageError(description: "--period-ms: a whole number of ms, \(Settings.minPeriod) to \(Settings.maxPeriod)")
                }
                options.periodMs = Int(n)
            default: throw UsageError(description: "unknown argument \(flag)")
            }
            i += 1
        }
        if (options.output == nil) == (options.measure == nil) {
            throw UsageError(description: "give either --snapshot or --measure")
        }
        if options.measure != nil {
            let snapshotOnly = ["--after", "--frames", "--every", "--scale"].filter(seen.contains)
            if !snapshotOnly.isEmpty {
                throw UsageError(description: "\(snapshotOnly.joined(separator: ", ")) only apply to --snapshot")
            }
        }
        if seen.contains("--every"), options.frames == 1 {
            throw UsageError(description: "--every needs --frames")
        }
        if let output = options.output {
            let folder = URL(fileURLWithPath: output).standardizedFileURL.deletingLastPathComponent()
            var isFolder: ObjCBool = false
            guard FileManager.default.fileExists(atPath: folder.path, isDirectory: &isFolder), isFolder.boolValue else {
                throw UsageError(description: "--snapshot: no folder \(folder.path)")
            }
        }
        return options
    }

    func outputPath(frame index: Int) -> String {
        let url = URL(fileURLWithPath: output!).standardizedFileURL
        if frames == 1 { return url.path }
        let stem = url.pathExtension.lowercased() == "png" ? url.deletingPathExtension() : url
        let width = max(2, String(frames).count)
        return stem.path + "-" + String(format: "%0\(width)d", index + 1) + ".png"
    }
}

@MainActor
final class Headless: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private static let loadTimeout: TimeInterval = 30
    private static let snapshotTimeout: TimeInterval = 15
    // --measure starts its clock this long after the page loads: past page start-up and the
    // feed's first line (python start-up plus its first full snapshot).
    private static let settle: TimeInterval = 3
    private static let rafProbe: TimeInterval = 2

    private let options: HeadlessOptions
    private let feed = Feed()
    private let settings = Settings.load()
    private lazy var target = options.design.map { PageTarget.design($0) } ?? PageTarget.resolve(settings.design)
    private lazy var periodMs = options.periodMs ?? settings.periodMs
    private var replay = ReplayCache()
    private var window: NSWindow?
    private var webView: WKWebView?
    private var loadedAt: Date?
    private var fixtureLines: [String] = []
    private var fixtureNext = 0
    private var fixtureTimer: Timer?
    private var activity: NSObjectProtocol?
    private var signals: [DispatchSourceSignal] = []
    private var pushed = 0
    private var scriptErrors = 0
    private var capturing = -1
    private var finished = false

    init(_ options: HeadlessOptions) { self.options = options }

    func applicationDidFinishLaunching(_ notification: Notification) {
        onSignal(SIGINT, status: 130)
        onSignal(SIGTERM, status: 143)
        if let fixture = options.fixture, !loadFixture(fixture) { return }
        guard let screen = NSScreen.main ?? NSScreen.screens.first else { return fail("no screen to render on") }
        // A run nobody can see is otherwise a candidate for App Nap, which would slow its timers
        // (the 1 Hz data, the snapshot clock) the way a visible wallpaper's are not.
        activity = ProcessInfo.processInfo.beginActivity(
            options: .userInitiatedAllowingIdleSystemSleep, reason: "KilnWall headless page run")

        let size = options.size ?? screen.frame.size
        let window = makeWindow(NSRect(origin: screen.frame.origin, size: size))
        let webView = KilnWall.makeWebView(size: size, messages: self)
        webView.navigationDelegate = self
        window.contentView = webView
        keepRenderingWhileUnseen(webView)
        window.orderFront(nil)
        self.window = window
        self.webView = webView
        if options.design == nil, target.design != settings.design {
            say("design \(settings.design) (settings.json) has no index.html; showing \(target.label)")
        }
        say("page \(target.index.path) (\(target.label)) at \(Int(size.width))x\(Int(size.height)) pt, backing scale \(window.backingScaleFactor), period \(periodMs) ms")
        feed.setPeriod(periodMs)
        KilnWall.loadPage(webView, target)
        after(Self.loadTimeout) { me in
            if me.loadedAt == nil { me.fail("the page did not finish loading within \(Int(Self.loadTimeout)) s") }
        }
    }

    // MARK: The window

    // WebKit stops requestAnimationFrame and throttles timers and animations for a page it thinks
    // nobody sees: a window that is not ordered in, or one the window server reports occluded
    // (covered, on another Space, or behind a full-screen app). So the window IS ordered in, on the
    // main screen (its display link drives rAF, at that screen's rate), but fully transparent,
    // click-through, and below the desktop, where it is never seen and never counts as a window
    // over the desktop (KilnWall's and LiveWall's coverage checks only look at the normal layer).
    // The window server will still call it occluded, so WebKit's occlusion check is turned off
    // for this web view (keepRenderingWhileUnseen). Measured 2026-11-04 on the stub page: with
    // the check on, here or with the window never ordered in, rAF never fired (the dot stayed
    // on its first frame while the text still updated); with it off, rAF ran at 60 Hz.
    private func makeWindow(_ frame: NSRect) -> NSWindow {
        let window = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.alphaValue = 0
        window.isOpaque = false
        window.backgroundColor = .clear
        window.ignoresMouseEvents = true
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.canHide = false
        window.hasShadow = false
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        window.setFrame(frame, display: false)
        return window
    }

    // Private WKWebView API (-_setWindowOcclusionDetectionEnabled:, in WebKit since 2017): with it
    // off, WebKit counts the view visible whenever its window is ordered in.
    private func keepRenderingWhileUnseen(_ webView: WKWebView) {
        let setter = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        guard webView.responds(to: setter) else {
            return say("warning: this WebKit lacks _setWindowOcclusionDetectionEnabled:; animation may be throttled")
        }
        typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
        unsafeBitCast(webView.method(for: setter), to: SetBool.self)(webView, setter, false)
        let now = (webView.value(forKey: "_windowOcclusionDetectionEnabled") as? NSNumber)?.boolValue
        if now != false { say("warning: WebKit occlusion detection is still on; animation may be throttled") }
    }

    // MARK: Page and data

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        KilnWall.configure(webView, ["design": target.design ?? settings.design, "period_ms": periodMs]) { [weak self] error in
            self?.say("page config error: \(error.localizedDescription)")
        }
        // The page navigated itself (a reload): as on the wallpaper, it gets the last on-change
        // blocks replayed, and the run (data, snapshot clock) carries on.
        if loadedAt != nil {
            if let line = replay.line {
                say("page reloaded; replayed \(replay.held)")
                push(line)
            } else {
                say("page reloaded; nothing to replay yet")
            }
            return
        }
        loadedAt = Date()
        say("page loaded (WebContent pid \(KilnWall.webProcessID(webView)))")
        // Only now: the first line is the only one certain to carry `analytics` (the feed sends it
        // only when it changes), so it must not reach a page that has not defined window.kiln yet.
        startData()
        if let seconds = options.measure { measure(seconds) } else { scheduleFrame(0) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail("the page failed to load: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail("the page failed: \(error.localizedDescription)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        fail("the page's WebContent process ended")
    }

    // The page may post to window.webkit.messageHandlers.kiln, as on the wallpaper; nothing to do.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {}

    private var dataSource: String {
        if let fixture = options.fixture { return "fixture \(fixture) (\(fixtureLines.count) lines, looping)" }
        return feed.mode
    }

    private func startData() {
        if options.fixture != nil {
            replayNext()
            let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.replayNext() }
            }
            timer.tolerance = 0.1
            RunLoop.main.add(timer, forMode: .common)
            fixtureTimer = timer
        } else {
            feed.onLine = { [weak self] line in self?.push(line) }
            feed.start()
        }
    }

    private func replayNext() {
        push(fixtureLines[fixtureNext])
        fixtureNext = (fixtureNext + 1) % fixtureLines.count
    }

    private func push(_ line: String) {
        guard let webView else { return }
        replay.note(line)
        pushed += 1
        KilnWall.send(line, to: webView) { [weak self] error in
            guard let self else { return }
            scriptErrors += 1
            if scriptErrors <= 3 { say("page script error #\(scriptErrors): \(error.localizedDescription)") }
        }
    }

    private func loadFixture(_ path: String) -> Bool {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            fail("cannot read the fixture \(path)")
            return false
        }
        for (number, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            // Checked once here; sent as text, like the feed's lines.
            guard (try? JSONSerialization.jsonObject(with: Data(trimmed.utf8))) is [String: Any] else {
                say("fixture line \(number + 1) is not a JSON object; skipped")
                continue
            }
            fixtureLines.append(trimmed)
        }
        if fixtureLines.isEmpty {
            fail("the fixture \(path) has no JSON object lines")
            return false
        }
        return true
    }

    // MARK: --snapshot

    private func scheduleFrame(_ index: Int) {
        guard let loadedAt else { return }
        let due = loadedAt.addingTimeInterval(options.after + Double(index) * options.every)
        after(max(0, due.timeIntervalSinceNow)) { me in me.capture(index) }
    }

    private func capture(_ index: Int) {
        guard let webView, let loadedAt else { return }
        let pageTime = Date().timeIntervalSince(loadedAt)
        capturing = index
        after(Self.snapshotTimeout) { me in
            if me.capturing == index { me.fail("snapshot \(index + 1) did not complete within \(Int(Self.snapshotTimeout)) s") }
        }
        let configuration = WKSnapshotConfiguration()
        configuration.afterScreenUpdates = true
        webView.takeSnapshot(with: configuration) { [weak self] image, error in
            guard let self, !finished, capturing == index else { return }
            capturing = -1
            guard let image else {
                return fail("snapshot \(index + 1) failed: \(error?.localizedDescription ?? "no image")")
            }
            let path = options.outputPath(frame: index)
            if let problem = writePNG(image, to: path) { return fail(problem) }
            say(String(format: "frame %d/%d at %.2f s page time; %d data lines pushed from %@",
                       index + 1, options.frames, pageTime, pushed, dataSource))
            print(path)
            if index + 1 < options.frames { scheduleFrame(index + 1) } else { finish(0) }
        }
    }

    // Exactly size × scale pixels, sRGB, on black: the wallpaper window is opaque black under a
    // web view that draws no background of its own.
    private func writePNG(_ image: NSImage, to path: String) -> String? {
        let points = webView?.bounds.size ?? image.size
        let width = Int((points.width * CGFloat(options.scale)).rounded())
        let height = Int((points.height * CGFloat(options.scale)).rounded())
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return "cannot make a \(width)x\(height) bitmap" }
        context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.interpolationQuality = .high
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        image.draw(in: NSRect(x: 0, y: 0, width: width, height: height), from: .zero, operation: .sourceOver, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        guard let flat = context.makeImage(),
              let destination = CGImageDestinationCreateWithURL(
                URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil)
        else { return "cannot write \(path)" }
        CGImageDestinationAddImage(destination, flat, nil)
        return CGImageDestinationFinalize(destination) ? nil : "cannot write \(path)"
    }

    // MARK: --measure

    private struct Sample {
        let label: String
        let pid: pid_t
        let note: String
    }

    private func measure(_ seconds: Double) {
        after(Self.settle) { me in
            guard let webView = me.webView else { return }
            var samples = [
                Sample(label: "KilnWall (host)", pid: getpid(), note: ""),
                Sample(label: "WebContent", pid: pid_t(KilnWall.webProcessID(webView)), note: ""),
            ]
            if let gpu = Self.privatePID(webView, "_gpuProcessIdentifier") {
                samples.append(Sample(label: "WebKit GPU", pid: gpu, note: "draws and composites the page"))
            }
            if let feed = me.feed.childPID {
                samples.append(Sample(label: "kiln-feed.py", pid: feed, note: "the data, not the page"))
            }
            let start = samples.map { Self.cpuSeconds($0.pid) }
            let startedAt = Date()
            me.after(seconds) { me in
                let end = samples.map { Self.cpuSeconds($0.pid) }
                let elapsed = Date().timeIntervalSince(startedAt)
                me.probeAnimationRate { hz in
                    me.report(samples, start, end, elapsed, hz)
                    me.finish(0)
                }
            }
        }
    }

    private func report(_ samples: [Sample], _ start: [Double?], _ end: [Double?], _ elapsed: Double, _ hz: Double?) {
        guard let window else { return }
        let size = window.frame.size
        let display = window.screen?.maximumFramesPerSecond ?? 0
        print(String(format: "KilnWall --measure: %.1f s at %dx%d pt (backing scale %.0f) on a %d Hz display; data: %@",
                     elapsed, Int(size.width), Int(size.height), window.backingScaleFactor, display, dataSource))
        var core: [Double] = []
        for (i, sample) in samples.enumerated() {
            guard let a = start[i], let b = end[i] else {
                print("  \(sample.label.padding(toLength: 16, withPad: " ", startingAt: 0)) pid \(sample.pid): unreadable")
                continue
            }
            let used = b - a
            if i < 2 { core.append(used) }
            print(String(format: "  %@ pid %-6d %7.3f s CPU  %5.1f%% of one core%@",
                         sample.label.padding(toLength: 16, withPad: " ", startingAt: 0), sample.pid, used,
                         used / elapsed * 100, sample.note.isEmpty ? "" : "  (\(sample.note))"))
        }
        if core.count == 2 {
            let sum = core[0] + core[1]
            print(String(format: "  host + WebContent        %7.3f s CPU  %5.1f%% of one core", sum, sum / elapsed * 100))
        }
        if let hz {
            print(String(format: "  page requestAnimationFrame: %.1f Hz (display maximum %d Hz)", hz, display))
        } else {
            print("  page requestAnimationFrame: did not fire within \(Int(Self.rafProbe) + 3) s (throttled, or the page never asks for frames)")
        }
    }

    // How often the page's frames actually come, read after the CPU window so it is not counted.
    private func probeAnimationRate(_ done: @escaping (Double?) -> Void) {
        guard let webView else { return done(nil) }
        var answered = false
        let script = """
            const frame = () => new Promise(r => requestAnimationFrame(r));
            const t0 = await frame();
            let n = 0, t = t0;
            while (t - t0 < ms) { t = await frame(); n++; }
            return n * 1000 / (t - t0);
            """
        webView.callAsyncJavaScript(script, arguments: ["ms": Self.rafProbe * 1000], in: nil, in: .page) { result in
            guard !answered else { return }
            answered = true
            if case .success(let value) = result { done((value as? NSNumber)?.doubleValue) } else { done(nil) }
        }
        after(Self.rafProbe + 3) { _ in
            guard !answered else { return }
            answered = true
            done(nil)
        }
    }

    private static func privatePID(_ webView: WKWebView, _ key: String) -> pid_t? {
        guard webView.responds(to: NSSelectorFromString(key)),
              let pid = (webView.value(forKey: key) as? NSNumber)?.int32Value, pid > 0
        else { return nil }
        return pid
    }

    // User + system CPU seconds. rusage_info times are Mach absolute-time ticks (1 tick = 1 ns
    // on Intel, 125/3 ns on Apple silicon), hence the timebase.
    static func cpuSeconds(_ pid: pid_t) -> Double? {
        var info = rusage_info_v2()
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V2, $0) }
        }
        guard status == 0 else { return nil }
        var timebase = mach_timebase_info_data_t()
        mach_timebase_info(&timebase)
        let ticks = Double(info.ri_user_time + info.ri_system_time)
        return ticks * Double(timebase.numer) / Double(timebase.denom) / 1e9
    }

    // MARK: Plumbing

    // A Timer with a tight tolerance, not DispatchQueue.asyncAfter: that may fire up to 10% late
    // (measured: --after 8 captured at 8.40 s, --measure 20 ran 21.0 s).
    private func after(_ seconds: TimeInterval, _ body: @escaping (Headless) -> Void) {
        let timer = Timer(timeInterval: max(0, seconds), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.finished else { return }
                body(self)
            }
        }
        timer.tolerance = 0.005
        RunLoop.main.add(timer, forMode: .common)
    }

    private func say(_ message: String) {
        FileHandle.standardError.write(Data("KilnWall: \(message)\n".utf8))
    }

    private func fail(_ message: String) {
        say("error: \(message)")
        finish(1)
    }

    private func onSignal(_ number: Int32, status: Int32) {
        signal(number, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.finish(status) }
        }
        source.resume()
        signals.append(source)
    }

    // Stops the data first and waits for kiln-feed.py to exit (it saves its analytics cache on
    // SIGTERM), so nothing is left running.
    private func finish(_ status: Int32) {
        guard !finished else { return }
        finished = true
        fixtureTimer?.invalidate()
        if let child = feed.stop() {
            let deadline = Date().addingTimeInterval(5)
            while child.isRunning, Date() < deadline {
                RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
            }
            if child.isRunning {
                say("kiln-feed.py (pid \(child.processIdentifier)) did not exit within 5 s of SIGTERM; killing it")
                kill(child.processIdentifier, SIGKILL)
            }
        }
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
        exit(status)
    }
}
