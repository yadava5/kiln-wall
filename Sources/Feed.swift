// The data feed, one JSON object per line, from the first of:
//   1. the shared feed: a `kiln-feed.py --serve` on a unix socket (scripts/install-agent.sh runs
//      one as a LaunchAgent), which every app reading this feed subscribes to, so they see the
//      same session state at the same instant and the work is done once;
//   2. kiln-feed.py as a child process, as before the shared feed existed;
//   3. a built-in stub while that script does not exist.
// Started and stopped by KilnWall as visibility changes. Lines are passed on as text, unparsed:
// the page parses them (see KilnWall.send).
// The shared feed is told `want all` and `period <ms>` on the socket; closing it unsubscribes.
// A child's stdin is a pipe: `period <ms>\n` on it changes the period live (no restart), and
// closing it (EOF) ends the child. On a child or the stub, the socket is tried again every
// retryInterval, so a feed agent installed (or restarted) later is picked up.
import Foundation
import os

@MainActor
final class Feed {
    // $KILN_FEED_SCRIPT if set (a "~/" prefix is expanded); else the first of
    // ~/.config/kiln-wall/feed/kiln-feed.py (where the README installs it) and
    // ~/.config/kitty/kiln-feed.py (where it lives beside the kitty setup) that exists;
    // else the first, so the "missing" log names the documented place.
    nonisolated static let defaultScript: String = {
        if let path = ProcessInfo.processInfo.environment["KILN_FEED_SCRIPT"], !path.isEmpty {
            return (path as NSString).expandingTildeInPath
        }
        let home = NSHomeDirectory() as NSString
        let places = [".config/kiln-wall/feed/kiln-feed.py", ".config/kitty/kiln-feed.py"].map(home.appendingPathComponent)
        return places.first(where: FileManager.default.fileExists(atPath:)) ?? places[0]
    }()
    // Where kiln-feed.py --serve listens: $KILN_FEED_SOCK, else its default.
    nonisolated static let socketPath: String = {
        if let path = ProcessInfo.processInfo.environment["KILN_FEED_SOCK"], !path.isEmpty {
            return (path as NSString).expandingTildeInPath
        }
        return (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/kiln-feed/feed.sock")
    }()
    private static let python = "/usr/bin/python3"
    private static let retryInterval: TimeInterval = 30
    private static let maxBackoff: TimeInterval = 60
    // A child that ran this long before exiting is treated as healthy: the backoff starts over.
    private static let healthyRun: TimeInterval = 60

    var onLine: ((String) -> Void)?

    // Parameters so the child-process path can be exercised against a test script, and so
    // --snapshot / --measure (Headless) keep a child of their own. KILN_FEED_SHARED=0 turns the
    // shared feed off.
    private let script: String
    private let shared: Bool
    init(script: String = Feed.defaultScript,
         shared: Bool = ProcessInfo.processInfo.environment["KILN_FEED_SHARED"] != "0") {
        self.script = script
        self.shared = shared
    }

    private var wanted = false
    private var process: Process?
    private var link: SharedLink?
    private var startedAt = Date()
    // Bumped whenever the current source is abandoned, so its late lines and exit are ignored.
    private var generation = 0
    private var stubTimer: Timer?
    private var retryTimer: Timer?
    private var sharedTimer: Timer?
    private var restartWork: DispatchWorkItem?
    private var backoff: TimeInterval = 1
    private var lines = 0
    // The write end of the current child's stdin.
    private var commands: FileHandle?
    // What every child is started with, and told when it changes.
    private(set) var periodMs = Settings.defaults.periodMs

    var mode: String {
        wanted && (process != nil || link != nil || stubTimer != nil) ? "\(source), \(periodMs) ms" : source
    }

    // The same without the period, for the menu, which shows the period on its own.
    var source: String {
        if !wanted { return "Feed stopped" }
        if link != nil { return "Feed: shared kiln-feed (subscribed)" }
        if let process { return "Feed: kiln-feed.py (pid \(process.processIdentifier))" }
        if stubTimer != nil { return "Feed: built-in stub (kiln-feed.py missing)" }
        return "Feed: restarting kiln-feed.py"
    }

    // Live: the shared feed or a running child is told, so it keeps its state (and a child its
    // pid). A child started later (start, restart after a crash) is started with the current period.
    func setPeriod(_ ms: Int) {
        let ms = Settings.clamp(ms)
        guard ms != periodMs else { return }
        periodMs = ms
        if let link {
            if link.send("period \(ms)\n") {
                log("feed: told the shared feed period \(ms) ms")
            } else {
                log("feed: cannot send the period to the shared feed")
            }
        } else if let process, let commands {
            do {
                try commands.write(contentsOf: Data("period \(ms)\n".utf8))
                log("feed: told kiln-feed.py (pid \(process.processIdentifier)) period \(ms) ms")
            } catch {
                log("feed: cannot send the period to kiln-feed.py (pid \(process.processIdentifier)): \(error.localizedDescription)")
            }
        } else if stubTimer != nil {
            startStubTimer()
        }
    }

    func start() {
        guard !wanted else { return }
        wanted = true
        backoff = 1
        launch()
    }

    // The running kiln-feed.py child's pid, if any (for --measure). Nil on the shared feed.
    var childPID: Int32? { process?.processIdentifier }

    // Returns the child it terminated, so a caller about to exit can wait for it.
    @discardableResult
    func stop() -> Process? {
        guard wanted else { return nil }
        wanted = false
        restartWork?.cancel()
        restartWork = nil
        stopStub()
        stopSharedRetry()
        if link != nil {
            dropLink()
            log("feed: unsubscribed from the shared feed")
        }
        guard let process else { return nil }
        generation += 1
        self.process = nil
        closeCommands()
        if process.isRunning { process.terminate() }
        log("feed: stopped kiln-feed.py (pid \(process.processIdentifier))")
        return process
    }

    private func launch() {
        guard wanted, process == nil, link == nil else { return }
        if subscribe() {
            stopStub()
            stopSharedRetry()
            return
        }
        if FileManager.default.fileExists(atPath: script) {
            stopStub()
            spawn()
        } else {
            startStub()
        }
        startSharedRetry()
    }

    // MARK: Shared feed

    // True if the shared feed answered and was subscribed to. The generation moves only then:
    // a failed try leaves a running child's lines counted.
    private func subscribe() -> Bool {
        guard shared else { return false }
        let current = generation + 1
        let reader = LineReader { [weak self] line in
            let text = Self.looksLikeObject(line) ? String(decoding: line, as: UTF8.self) : nil
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.received(text, bytes: line.count, from: current) }
            }
        }
        let closed: @Sendable () -> Void = { [weak self] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.sharedClosed(from: current) }
            }
        }
        guard let link = SharedLink(path: Self.socketPath, onData: reader.append, onClose: closed) else { return false }
        guard link.send("hello kilnwall\nwant all\nperiod \(periodMs)\n") else {
            link.close()
            return false
        }
        generation = current
        self.link = link
        lines = 0
        startedAt = Date()
        log("feed: subscribed to the shared feed at \(Self.socketPath), \(periodMs) ms")
        return true
    }

    private func dropLink() {
        generation += 1
        link?.close()
        link = nil
    }

    // The shared feed went away while subscribed (its agent restarting, or uninstalled): the
    // socket first, else a child, after the usual backoff.
    private func sharedClosed(from source: Int) {
        guard source == generation, wanted, link != nil else { return }
        link = nil
        if Date().timeIntervalSince(startedAt) >= Self.healthyRun { backoff = 1 }
        log("feed: the shared feed closed the connection")
        scheduleRestart()
    }

    // On a child or the stub: every retryInterval, move to the shared feed if it answers now.
    private func startSharedRetry() {
        guard shared, sharedTimer == nil else { return }
        let timer = Timer(timeInterval: Self.retryInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.retryShared() }
        }
        timer.tolerance = 2
        RunLoop.main.add(timer, forMode: .common)
        sharedTimer = timer
    }

    private func stopSharedRetry() {
        sharedTimer?.invalidate()
        sharedTimer = nil
    }

    private func retryShared() {
        guard wanted, link == nil, process != nil || stubTimer != nil else { return }
        let old = process
        // Subscribed first, then the child ended: no gap in lines. Its late lines and exit
        // belong to an older generation and are ignored.
        guard subscribe() else { return }
        stopSharedRetry()
        stopStub()
        if let old {
            process = nil
            closeCommands()
            if old.isRunning { old.terminate() }
            log("feed: moved to the shared feed; stopped kiln-feed.py (pid \(old.processIdentifier))")
        }
    }

    // MARK: Child process

    private func spawn() {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: Self.python)
        child.arguments = [script, "--stream", "--period-ms", String(periodMs)]
        var environment = ProcessInfo.processInfo.environment
        environment["PYTHONUNBUFFERED"] = "1"  // a pipe would otherwise hold lines in a 4 KB buffer
        child.environment = environment
        let input = Pipe(), out = Pipe(), err = Pipe()
        child.standardInput = input
        child.standardOutput = out
        child.standardError = err

        generation += 1
        let current = generation
        lines = 0
        let stdoutLines = LineReader { [weak self] line in
            let text = Self.looksLikeObject(line) ? String(decoding: line, as: UTF8.self) : nil
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.received(text, bytes: line.count, from: current) }
            }
        }
        let stderrLines = LineReader { line in
            let text = String(decoding: line.prefix(1000), as: UTF8.self)
            logger.notice("feed stderr: \(text, privacy: .public)")
        }
        out.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { stdoutLines.append(data) }
        }
        err.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { stderrLines.append(data) }
        }
        child.terminationHandler = { [weak self] finished in
            let status = finished.terminationStatus
            let signalled = finished.terminationReason == .uncaughtSignal
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.exited(status: status, signalled: signalled, from: current) }
            }
        }

        do {
            try child.run()
            process = child
            commands = input.fileHandleForWriting
            startedAt = Date()
            log("feed: started kiln-feed.py (pid \(child.processIdentifier)) at \(periodMs) ms")
        } catch {
            log("feed: cannot start kiln-feed.py: \(error.localizedDescription)")
            scheduleRestart()
        }
    }

    // Only a cheap shape check ({ ... }, so not a traceback or a stray print): the page parses the
    // line and ignores one that is not JSON.
    nonisolated static func looksLikeObject(_ line: Data) -> Bool {
        let blank: Set<UInt8> = [0x20, 0x09, 0x0D]
        return line.first { !blank.contains($0) } == UInt8(ascii: "{")
            && line.last { !blank.contains($0) } == UInt8(ascii: "}")
    }

    private func received(_ line: String?, bytes: Int, from source: Int) {
        guard source == generation, wanted else { return }
        guard let line else {
            log("feed: skipped a line that is not a JSON object (\(bytes) bytes)")
            return
        }
        lines += 1
        if lines == 1 || lines % 60 == 0 {
            log("feed: line \(lines) from \(link != nil ? "the shared feed" : "kiln-feed.py"), \(bytes) bytes")
        }
        onLine?(line)
    }

    private func exited(status: Int32, signalled: Bool, from source: Int) {
        guard source == generation, wanted else { return }  // stopped on purpose, or superseded
        process = nil
        closeCommands()
        if Date().timeIntervalSince(startedAt) >= Self.healthyRun { backoff = 1 }
        log("feed: kiln-feed.py \(signalled ? "killed by signal" : "exited with status") \(status)")
        scheduleRestart()
    }

    // EOF on the child's stdin: it ends by itself (stop() also sends SIGTERM).
    private func closeCommands() {
        try? commands?.close()
        commands = nil
    }

    private func scheduleRestart() {
        let delay = backoff
        backoff = min(backoff * 2, Self.maxBackoff)
        log("feed: restarting in \(Int(delay)) s")
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.restartWork = nil
                self?.launch()
            }
        }
        restartWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    // MARK: Stub

    private func startStub() {
        guard stubTimer == nil else { return }
        log("feed: \(script) not found; using the built-in stub, retrying every \(Int(Self.retryInterval)) s")
        emitStub()
        startStubTimer()
        let retry = Timer(timeInterval: Self.retryInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.retryReal() }
        }
        retry.tolerance = 2
        RunLoop.main.add(retry, forMode: .common)
        retryTimer = retry
    }

    private func startStubTimer() {
        stubTimer?.invalidate()
        let interval = Double(periodMs) / 1000
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.emitStub() }
        }
        timer.tolerance = interval / 10
        RunLoop.main.add(timer, forMode: .common)
        stubTimer = timer
    }

    private func stopStub() {
        stubTimer?.invalidate()
        stubTimer = nil
        retryTimer?.invalidate()
        retryTimer = nil
    }

    private func emitStub() {
        let now = (Date().timeIntervalSince1970 * 1000).rounded() / 1000
        let object: [String: Any] = ["v": 1, "t": now, "stub": true, "feed": ["period_ms": periodMs]]
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        onLine?(String(decoding: data, as: UTF8.self))
    }

    private func retryReal() {
        guard wanted, link == nil, FileManager.default.fileExists(atPath: script) else { return }
        log("feed: \(script) appeared; switching from the stub")
        stopStub()
        spawn()
    }
}

// One connection to kiln-feed.py --serve. Read on a dispatch source with plain read(2), so a
// reset connection is an ordinary close rather than an exception; the descriptor is closed by
// the source's cancel handler, once.
final class SharedLink: @unchecked Sendable {
    private static let queue = DispatchQueue(label: "kilnwall.feed.shared")
    private let fd: Int32
    private let source: DispatchSourceRead

    // Nil if nothing answers at `path` (no agent installed, or not running).
    init?(path: String, onData: @escaping (Data) -> Void, onClose: @escaping @Sendable () -> Void) {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        var addr = sockaddr_un()
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            Darwin.close(fd)
            return nil
        }
        addr.sun_family = sa_family_t(AF_UNIX)
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let connected = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            Darwin.close(fd)
            return nil
        }
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        self.fd = fd
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: Self.queue)
        self.source = source
        var buffer = [UInt8](repeating: 0, count: 1 << 16)
        source.setEventHandler { [source] in
            let n = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
            if n > 0 {
                onData(Data(buffer[0..<n]))
            } else if n == 0 || (errno != EAGAIN && errno != EINTR) {
                source.cancel()
                onClose()
            }
        }
        source.setCancelHandler { Darwin.close(fd) }
        source.resume()
    }

    // Commands are a few bytes; a full send buffer (never seen) or a closed socket returns false.
    func send(_ text: String) -> Bool {
        let data = Array(text.utf8)
        var sent = 0
        while sent < data.count {
            let n = data[sent...].withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
            if n > 0 {
                sent += n
            } else if n < 0 && errno == EINTR {
                continue
            } else {
                return false
            }
        }
        return true
    }

    func close() { source.cancel() }
}

// Splits a byte stream into lines. Only ever called from one FileHandle's readability handler or
// one SharedLink's queue, each serial, so the buffer needs no lock.
final class LineReader: @unchecked Sendable {
    private static let maxLine = 4 << 20
    private var buffer = Data()
    private let onLine: (Data) -> Void

    init(_ onLine: @escaping (Data) -> Void) { self.onLine = onLine }

    func append(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newline]
            buffer.removeSubrange(buffer.startIndex...newline)
            if !line.isEmpty { onLine(Data(line)) }
        }
        // A runaway line with no newline must not grow without bound.
        if buffer.count > Self.maxLine { buffer.removeAll() }
    }
}
