import CryptoKit
import Foundation

/// An additional binary loaded for multi-file comparison (e.g. Stock, Stage 1, Stage 2).
struct CompareFile: Identifiable, Hashable {
    let id: UUID
    var name: String
    var url: URL?
    var bytes: [UInt8]

    init(id: UUID = UUID(), name: String, url: URL? = nil, bytes: [UInt8]) {
        self.id = id
        self.name = name
        self.url = url
        self.bytes = bytes
    }

    static func == (lhs: CompareFile, rhs: CompareFile) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// One recorded edit to an XDF item, persisted across sessions.
struct EditHistoryEntry: Identifiable, Codable, Hashable {
    let id: UUID
    var timestamp: Date
    var itemKey: String
    var itemTitle: String
    var address: Int
    var summary: String
    var note: String

    init(id: UUID = UUID(), timestamp: Date = Date(), itemKey: String, itemTitle: String,
         address: Int, summary: String, note: String = "") {
        self.id = id
        self.timestamp = timestamp
        self.itemKey = itemKey
        self.itemTitle = itemTitle
        self.address = address
        self.summary = summary
        self.note = note
    }
}

/// Named binary snapshot metadata (raw bytes are stored in a companion file).
struct BinSnapshotMeta: Identifiable, Codable, Hashable {
    let id: UUID
    var name: String
    var note: String
    var createdAt: Date
    var byteCount: Int

    init(id: UUID = UUID(), name: String, note: String = "", createdAt: Date = Date(), byteCount: Int) {
        self.id = id
        self.name = name
        self.note = note
        self.createdAt = createdAt
        self.byteCount = byteCount
    }
}

enum StoragePaths {
    static var appSupport: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        let dir = base.appendingPathComponent("MacTuner", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func keyHash(_ key: String) -> String {
        let digest = SHA256.hash(data: Data(key.utf8))
        return digest.prefix(12).map { String(format: "%02x", $0) }.joined()
    }
}

enum HistoryStore {
    private static func fileURL(for binKey: String) -> URL {
        let dir = StoragePaths.appSupport.appendingPathComponent("History", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(StoragePaths.keyHash(binKey)).json")
    }

    static func load(for binKey: String) -> [EditHistoryEntry] {
        let url = fileURL(for: binKey)
        guard let data = try? Data(contentsOf: url) else { return [] }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        return (try? dec.decode([EditHistoryEntry].self, from: data)) ?? []
    }

    static func save(_ entries: [EditHistoryEntry], for binKey: String) {
        let url = fileURL(for: binKey)
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.prettyPrinted]
        guard let data = try? enc.encode(entries) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

enum SnapshotStore {
    private static func dirURL(for binKey: String) -> URL {
        let dir = StoragePaths.appSupport
            .appendingPathComponent("Snapshots", isDirectory: true)
            .appendingPathComponent(StoragePaths.keyHash(binKey), isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func loadIndex(for binKey: String) -> [BinSnapshotMeta] {
        let url = dirURL(for: binKey).appendingPathComponent("index.json")
        guard let data = try? Data(contentsOf: url) else { return [] }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        return (try? dec.decode([BinSnapshotMeta].self, from: data)) ?? []
    }

    static func saveIndex(_ list: [BinSnapshotMeta], for binKey: String) {
        let url = dirURL(for: binKey).appendingPathComponent("index.json")
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = [.prettyPrinted]
        guard let data = try? enc.encode(list) else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func saveSnapshot(_ meta: BinSnapshotMeta, bytes: [UInt8], for binKey: String) throws {
        let binFile = dirURL(for: binKey).appendingPathComponent("\(meta.id.uuidString).bin")
        try Data(bytes).write(to: binFile, options: .atomic)
    }

    static func loadBytes(id: UUID, for binKey: String) -> [UInt8]? {
        let binFile = dirURL(for: binKey).appendingPathComponent("\(id.uuidString).bin")
        guard let data = try? Data(contentsOf: binFile) else { return nil }
        return [UInt8](data)
    }

    static func deleteSnapshot(id: UUID, for binKey: String) {
        let binFile = dirURL(for: binKey).appendingPathComponent("\(id.uuidString).bin")
        try? FileManager.default.removeItem(at: binFile)
    }
}
