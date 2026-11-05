// The data feed: kiln-feed.py as a child process, one JSON object per stdout line, or a built-in
// stub while that script does not exist. Started and stopped by KilnWall as visibility changes.
// The child's stdin is a pipe: `period <ms>\n` on it changes the period live (no restart), and
// closing it (EOF) ends the child.
import Foundation
import os

@MainActor
final class Feed {
    nonisolated static let defaultScript = "/Users/ayush/.config/kitty/kiln-feed.py"
    private static let python = "/usr/bin/python3"
    private static let retryInterval: TimeInterval = 30
    private static let maxBackoff: TimeInterval = 60
    // A child that ran this long before exiting is treated as healthy: the backoff starts over.
    private static let healthyRun: TimeInterval = 60

    var onJSON: (([String: Any]) -> Void)?

    // A parameter only so the child-process path can be exercised against a test script.
    private let script: String
    init(script: String = Feed.defaultScript) { self.script = script }

    private var wanted = false
    private var process: Process?
    private var startedAt = Date()
    // Bumped whenever the current child is abandoned, so its late lines and exit are ignored.
    private var generation = 0
    private var stubTimer: Timer?
    private var retryTimer: Timer?
    private var restartWork: DispatchWorkItem?
    private var backoff: TimeInterval = 1
    private var lines = 0
    // The write end of the current child's stdin.
    private var commands: FileHandle?
    // What every child is started with, and told when it changes.
    private(set) var periodMs = Settings.defaults.periodMs

    var mode: String {
        if !wanted { return "Feed stopped" }
        if let process { return "Feed: kiln-feed.py (pid \(process.processIdentifier)), \(periodMs) ms" }
        if stubTimer != nil { return "Feed: built-in stub (kiln-feed.py missing), \(periodMs) ms" }
        return "Feed: restarting kiln-feed.py"
    }

    // Live: a running child is told on its stdin, so it keeps its state and pid. A child started
    // later (start, restart after a crash) is started with the current period.
    func setPeriod(_ ms: Int) {
        let ms = Settings.clamp(ms)
        guard ms != periodMs else { return }
        periodMs = ms
        if let process, let commands {
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

    // The running kiln-feed.py's pid, if any (for --measure).
    var childPID: Int32? { process?.processIdentifier }

    // Returns the child it terminated, so a caller about to exit can wait for it.
    @discardableResult
    func stop() -> Process? {
        guard wanted else { return nil }
        wanted = false
        restartWork?.cancel()
        restartWork = nil
        stopStub()
        guard let process else { return nil }
        generation += 1
        self.process = nil
        closeCommands()
        if process.isRunning { process.terminate() }
        log("feed: stopped kiln-feed.py (pid \(process.processIdentifier))")
        return process
    }

    private func launch() {
        guard wanted, process == nil else { return }
        if FileManager.default.fileExists(atPath: script) {
            stopStub()
            spawn()
        } else {
            startStub()
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
            let object = try? JSONSerialization.jsonObject(with: line)
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.received(object, bytes: line.count, from: current) }
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

    private func received(_ object: Any?, bytes: Int, from source: Int) {
        guard source == generation, wanted else { return }
        guard let json = object as? [String: Any] else {
            log("feed: skipped a line that is not a JSON object (\(bytes) bytes)")
            return
        }
        lines += 1
        if lines == 1 || lines % 60 == 0 { log("feed: line \(lines) from kiln-feed.py, \(bytes) bytes") }
        onJSON?(json)
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
        onJSON?(["v": 1, "t": now, "stub": true, "feed": ["period_ms": periodMs]])
    }

    private func retryReal() {
        guard wanted, FileManager.default.fileExists(atPath: script) else { return }
        log("feed: \(script) appeared; switching from the stub")
        stopStub()
        spawn()
    }
}

// Splits a byte stream into lines. Only ever called from one FileHandle's readability handler,
// which runs serially, so the buffer needs no lock.
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
