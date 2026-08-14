import AppKit
import SwiftUI

// MARK: - Low-level HTTP client for the bun JSON API (app/server.ts)

enum API {
    static var base: String {
        let port = ProcessInfo.processInfo.environment["BACKFILL_APP_PORT"] ?? "47710"
        return "http://localhost:\(port)"
    }
}

struct APIClient {
    struct Busy: Error {}                                   // 409 — job lock held
    struct HTTPError: Error { let status: Int; let message: String }

    private func url(_ path: String) -> URL { URL(string: API.base + path)! }

    func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, resp) = try await URLSession.shared.data(from: url(path))
        try check(resp, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func post(_ path: String, body: Data? = nil) async throws {
        var req = URLRequest(url: url(path))
        req.httpMethod = "POST"
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
    }

    func raw(_ path: String) async throws -> Data {
        let (data, resp) = try await URLSession.shared.data(from: url(path))
        try check(resp, data)
        return data
    }

    private func check(_ resp: URLResponse, _ data: Data) throws {
        guard let http = resp as? HTTPURLResponse else { return }
        if http.statusCode == 409 { throw Busy() }
        guard (200 ..< 300).contains(http.statusCode) else {
            let msg = (try? JSONDecoder().decode([String: String?].self, from: data))?["error"]
                .flatMap { $0 } ?? String(data: data, encoding: .utf8) ?? "unknown"
            throw HTTPError(status: http.statusCode, message: msg)
        }
    }
}

// MARK: - Store

struct MessagesSheetData: Identifiable {
    let channel: ChannelRow
    let messages: [MessageRow]
    var id: String { channel.id }
}

@MainActor
final class BackfillStore: ObservableObject {
    @Published var stats: Stats?
    @Published var gaps: GapsResponse = .empty
    @Published var job: JobState?
    @Published var errorMessage: String?
    @Published var busyAlert = false
    @Published var messagesSheet: MessagesSheetData?
    @Published var loadingMessagesFor: String?

    private let api = APIClient()
    private var pollTask: Task<Void, Never>?

    deinit { pollTask?.cancel() }

    var jobRunning: Bool { job?.running ?? false }

    // MARK: lifecycle

    /// Called once when the server is confirmed up.
    func bootstrap() async {
        await refreshAll()
        if jobRunning { watchJob() }   // reattach to a job started before launch
    }

    func refreshAll() async {
        await loadStats()
        await loadGaps()
        await loadJob()
    }

    func loadStats() async {
        do { stats = try await api.get("/api/stats"); errorMessage = nil }
        catch { fail("โหลด stats ไม่ได้", error) }
    }

    func loadGaps() async {
        do { gaps = try await api.get("/api/gaps") }
        catch { fail("โหลด gaps ไม่ได้", error) }
    }

    func loadJob() async {
        do { job = try await api.get("/api/job") }
        catch { fail("โหลด job ไม่ได้", error) }
    }

    // MARK: job actions (share the server-side one-job lock)

    func startSweep() {
        startJob(path: "/api/sweep", body: nil)
    }

    func startGapScan() {
        startJob(path: "/api/gaps/scan", body: nil)
    }

    func startBackfill(_ channelId: String) {
        let body = try? JSONSerialization.data(withJSONObject: ["channelId": channelId])
        startJob(path: "/api/backfill", body: body)
    }

    private func startJob(path: String, body: Data?) {
        Task {
            do {
                try await api.post(path, body: body)
                errorMessage = nil
                watchJob()
            } catch is APIClient.Busy {
                busyAlert = true      // web parity: alert, do not start polling
            } catch {
                fail("สั่ง job ไม่สำเร็จ", error)
            }
        }
    }

    /// Poll /api/job every 1s until done, then refresh stats + gaps (web `watchJob()` parity).
    /// Bails out after repeated fetch failures (server died mid-job) instead of
    /// polling forever with the UI locked.
    func watchJob() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            var failures = 0
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    let j: JobState = try await self.api.get("/api/job")
                    failures = 0
                    self.job = j
                    if j.done { break }
                } catch {
                    failures += 1
                    if failures >= 5 {                    // ~5s of straight failures → give up
                        self.job = nil                    // unlock the job buttons
                        self.fail("ตาม job ไม่ได้ — server ไม่ตอบ", error)
                        break
                    }
                }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
            guard let self else { return }
            self.pollTask = nil
            await self.loadStats()
            await self.loadGaps()
        }
    }

    // MARK: messages viewer

    func viewMessages(_ channel: ChannelRow) {
        guard loadingMessagesFor == nil else { return }
        loadingMessagesFor = channel.id
        Task {
            defer { loadingMessagesFor = nil }
            do {
                let msgs: [MessageRow] = try await api.get("/api/messages?channel_id=\(channel.id)&limit=100")
                messagesSheet = MessagesSheetData(channel: channel, messages: msgs)
            } catch {
                fail("โหลดข้อความไม่ได้", error)
            }
        }
    }

    // MARK: export (download via URLSession → NSSavePanel)

    func export(_ channel: ChannelRow, format: String) {
        Task {
            do {
                let data = try await api.raw("/api/export?channel_id=\(channel.id)&format=\(format)")
                let panel = NSSavePanel()
                let base = (channel.name ?? channel.id)
                    .replacingOccurrences(of: "[^\\w฀-๿-]+", with: "_", options: .regularExpression)
                panel.nameFieldStringValue = "\(base).\(format)"
                panel.canCreateDirectories = true
                // Sheet-style begin() instead of runModal() — no nested runloop
                // pinning the main actor; the write happens off-main.
                if await panel.begin() == .OK, let dest = panel.url {
                    try await Task.detached(priority: .utility) {
                        try data.write(to: dest)
                    }.value
                }
            } catch {
                fail("export ไม่สำเร็จ", error)
            }
        }
    }

    // MARK: errors — surface as banner text, never crash

    private func fail(_ what: String, _ error: Error) {
        if let e = error as? APIClient.HTTPError {
            errorMessage = "\(what): HTTP \(e.status) — \(e.message)"
        } else {
            errorMessage = "\(what): \(error.localizedDescription)"
        }
    }
}
