import AppKit
import SwiftUI

// MARK: - Server lifecycle
// Probe /api/stats on launch; if the bun backend is down, spawn it ourselves
// and kill it on quit (ONLY if we spawned it).

@MainActor
final class ServerManager: ObservableObject {
    static let shared = ServerManager()

    enum State: Equatable {
        case probing, starting, ready
        case failed(String)
    }

    @Published var state: State = .probing

    private static let serverPath =
        "/opt/Code/github.com/Soul-Brews-Studio/atlas-discord-backfill-oracle/app/server.ts"
    private var child: Process?
    private var startTask: Task<Void, Never>?

    /// Re-entrancy-safe: a second caller (e.g. Cmd+N window, retry button)
    /// joins the in-flight start instead of double-spawning bun.
    func start() async {
        if let running = startTask {
            await running.value
            return
        }
        let t = Task { await runStart() }
        startTask = t
        await t.value
        startTask = nil
    }

    private func runStart() async {
        state = .probing
        if await probe() { state = .ready; return }

        state = .starting
        // Never overwrite a still-running child (e.g. retry after the 20s
        // timeout while the first bun is still coming up) — just re-probe.
        if child == nil || child?.isRunning != true {
            do { try spawn() } catch {
                state = .failed("spawn bun ไม่ได้: \(error.localizedDescription)")
                return
            }
        }
        for _ in 0 ..< 40 {                               // ≤ 20s at 0.5s steps
            try? await Task.sleep(nanoseconds: 500_000_000)
            if await probe() { state = .ready; return }
            if let c = child, !c.isRunning {
                state = .failed("bun server ตายก่อนพร้อม (exit \(c.terminationStatus)) — ดู /tmp/backfill-app.log")
                return
            }
        }
        state = .failed("server ไม่ตอบภายใน 20 วินาที — ดู /tmp/backfill-app.log")
    }

    private func probe() async -> Bool {
        guard let url = URL(string: "\(API.base)/api/stats") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            return (resp as? HTTPURLResponse)?.statusCode == 200
        } catch { return false }
    }

    private func spawn() throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["bun", Self.serverPath]

        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        env["PATH"] = "/opt/homebrew/bin:\(home)/.bun/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        env["BACKFILL_SPAWNED_BY_APP"] = "1"   // server self-terminates if the app dies without SIGTERM
        p.environment = env

        let logPath = "/tmp/backfill-app.log"
        FileManager.default.createFile(atPath: logPath, contents: nil)
        if let log = FileHandle(forWritingAtPath: logPath) {
            p.standardOutput = log
            p.standardError = log
        }
        // Detect backend death after .ready — otherwise the retry screen is unreachable.
        p.terminationHandler = { [weak self] proc in
            Task { @MainActor [weak self] in
                guard let self, self.child === proc else { return }
                if case .ready = self.state {
                    self.state = .failed("bun server ตายกลางคัน (exit \(proc.terminationStatus)) — ดู /tmp/backfill-app.log")
                }
            }
        }
        try p.run()
        child = p
    }

    /// Kill the bun child ONLY if this app spawned it.
    func killChildIfSpawned() {
        guard let c = child, c.isRunning else { return }
        c.terminate()
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillTerminate(_ notification: Notification) {
        ServerManager.shared.killChildIfSpawned()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

// MARK: - App

@main
struct BackfillApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup("Backfill — Discord Archive 🌊📜") {
            RootView()
                .preferredColorScheme(.dark)
        }
    }
}

// MARK: - Root: server gate → dashboard

struct RootView: View {
    @StateObject private var server = ServerManager.shared
    @StateObject private var store = BackfillStore()

    var body: some View {
        Group {
            switch server.state {
            case .ready:
                DashboardView()
                    .environmentObject(store)
            case .failed(let msg):
                placeholder(icon: "xmark.octagon.fill", color: Theme.bad, title: "server ล่ม", detail: msg) {
                    Button("ลองใหม่") {
                        Task {
                            await server.start()
                            if server.state == .ready { await store.bootstrap() }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                }
            default:
                placeholder(icon: nil, color: Theme.accent,
                            title: server.state == .probing ? "กำลังเช็ค server…" : "กำลังสตาร์ท bun server…",
                            detail: API.base) { EmptyView() }
            }
        }
        .frame(minWidth: 1100, minHeight: 760)
        .background(Theme.bg)
        .task {
            await server.start()
            if server.state == .ready { await store.bootstrap() }
        }
    }

    private func placeholder<Extra: View>(
        icon: String?, color: Color, title: String, detail: String,
        @ViewBuilder extra: () -> Extra
    ) -> some View {
        VStack(spacing: 14) {
            if let icon {
                Image(systemName: icon).font(.system(size: 36)).foregroundStyle(color)
            } else {
                ProgressView().controlSize(.large).tint(Theme.accent)
            }
            Text("🌊📜 Backfill").font(.system(.title2, design: .rounded).weight(.heavy))
                .foregroundStyle(.white)
            Text(title).font(.body.monospaced()).foregroundStyle(.white.opacity(0.85))
            Text(detail).font(.caption.monospaced()).foregroundStyle(Theme.dim)
            extra()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
    }
}
