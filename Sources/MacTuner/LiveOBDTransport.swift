import CoreBluetooth
import Darwin
import Foundation
import Network
import Observation

/// Pure OBD-II (Mode 01) & UDS (0x22 / 0x62) + DoIP protocol encoder/decoder.
enum OBDProtocolDecoder {
    struct DecodedPID: Equatable {
        let pid: UInt16
        let name: String
        let unit: String
        let value: Double
    }

    /// Parses an ASCII hex ELM327 response line (e.g. `"41 0C 1A F8"`) into raw bytes.
    static func parseHexLine(_ line: String) -> [UInt8] {
        let cleaned = line.replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: ">", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let tokens = cleaned.split(separator: " ")
        if tokens.count >= 2 && tokens.allSatisfy({ $0.count == 2 }) {
            return tokens.compactMap { UInt8($0, radix: 16) }
        }
        // Compact hex string without spaces (e.g. "410C1AF8")
        let hexOnly = cleaned.filter { $0.isHexDigit }
        guard hexOnly.count >= 4, hexOnly.count % 2 == 0 else { return [] }
        var out: [UInt8] = []
        var idx = hexOnly.startIndex
        while idx < hexOnly.endIndex {
            let next = hexOnly.index(idx, offsetBy: 2)
            if let b = UInt8(hexOnly[idx..<next], radix: 16) { out.append(b) }
            idx = next
        }
        return out
    }

    /// Decodes a standard SAE J1979 Mode 01 response (`[0x41, pid, A, (B)]`).
    static func decodeMode01(_ bytes: [UInt8]) -> DecodedPID? {
        guard bytes.count >= 3, bytes[0] == 0x41 else { return nil }
        let pid = bytes[1]
        let a = Double(bytes[2])
        let b = bytes.count >= 4 ? Double(bytes[3]) : 0.0
        switch pid {
        case 0x04: return DecodedPID(pid: 0x04, name: "Load", unit: "%", value: (a * 100.0) / 255.0)
        case 0x05: return DecodedPID(pid: 0x05, name: "Coolant", unit: "°C", value: a - 40.0)
        case 0x0B: return DecodedPID(pid: 0x0B, name: "MAP", unit: "mbar", value: a * 10.0)
        case 0x0C:
            guard bytes.count >= 4 else { return nil }
            return DecodedPID(pid: 0x0C, name: "RPM", unit: "rpm", value: ((a * 256.0) + b) / 4.0)
        case 0x0D: return DecodedPID(pid: 0x0D, name: "Speed", unit: "km/h", value: a)
        case 0x0E: return DecodedPID(pid: 0x0E, name: "Ignition", unit: "°KW", value: (a / 2.0) - 64.0)
        case 0x0F: return DecodedPID(pid: 0x0F, name: "IAT", unit: "°C", value: a - 40.0)
        case 0x11: return DecodedPID(pid: 0x11, name: "Throttle", unit: "%", value: (a * 100.0) / 255.0)
        case 0x44:
            guard bytes.count >= 4 else { return nil }
            return DecodedPID(pid: 0x44, name: "Lambda", unit: "λ", value: ((a * 256.0) + b) * (2.0 / 65536.0))
        default: return nil
        }
    }

    /// Decodes a UDS ReadDataByIdentifier positive response (`[0x62, didHi, didLo, data...]`).
    static func decodeUDS62(_ bytes: [UInt8]) -> DecodedPID? {
        guard bytes.count >= 4, bytes[0] == 0x62 else { return nil }
        let did = (UInt16(bytes[1]) << 8) | UInt16(bytes[2])
        // Standard OBD-over-UDS DIDs (0xF400 + Mode01 PID)
        if (did & 0xFF00) == 0xF400 {
            var m01: [UInt8] = [0x41, UInt8(did & 0xFF)]
            m01.append(contentsOf: bytes[3...])
            return decodeMode01(m01)
        }
        let rawVal: Double = bytes.count >= 5
            ? Double((UInt16(bytes[3]) << 8) | UInt16(bytes[4]))
            : Double(bytes[3])
        return DecodedPID(pid: did, name: String(format: "DID 0x%04X", did), unit: "raw", value: rawVal)
    }

    /// Builds a DoIP diagnostic message (ISO 13400) wrapping a UDS `0x22 ReadDataByIdentifier` request.
    static func buildDoIPReadDID(sourceAddr: UInt16 = 0x0E80, targetAddr: UInt16 = 0x0010, did: UInt16) -> [UInt8] {
        let udsPayload: [UInt8] = [0x22, UInt8((did >> 8) & 0xFF), UInt8(did & 0xFF)]
        let payloadLen = UInt32(4 + udsPayload.count)
        var frame: [UInt8] = [
            0x02, 0xFD, // Protocol version & inverse
            0x80, 0x01, // Payload type: Diagnostic message
            UInt8((payloadLen >> 24) & 0xFF), UInt8((payloadLen >> 16) & 0xFF),
            UInt8((payloadLen >> 8) & 0xFF), UInt8(payloadLen & 0xFF),
            UInt8((sourceAddr >> 8) & 0xFF), UInt8(sourceAddr & 0xFF),
            UInt8((targetAddr >> 8) & 0xFF), UInt8(targetAddr & 0xFF),
        ]
        frame.append(contentsOf: udsPayload)
        return frame
    }

    /// Decodes an ISO 13400 DoIP diagnostic message (`0x02 0xFD 0x8001 ...`) containing a UDS `0x62` reply.
    static func decodeDoIPDiagnosticResponse(_ frame: [UInt8]) -> DecodedPID? {
        guard frame.count >= 16,
              frame[0] == 0x02, frame[1] == 0xFD,
              frame[2] == 0x80, frame[3] == 0x01 else { return nil }
        let udsPayload = Array(frame[12...])
        return decodeUDS62(udsPayload)
    }
}

/// Live telemetry snapshot streamed at up to 20 Hz.
struct LiveTelemetrySample: Equatable {
    let timeSec: Double
    let rpm: Double
    let loadPct: Double
    let mapMbar: Double
    let lambda: Double
    let ignitionDeg: Double
    let speedKmh: Double
    let coolantC: Double
}

/// Transport mode for live OBD-II / UDS / BLE / Bench Simulator streaming.
enum LiveOBDTransportMode: String, CaseIterable, Identifiable {
    case simulator = "Prüfstand-Simulator (20 Hz)"
    case serial = "USB-Serial (ELM327 / OBDLink / K+DCAN)"
    case enetDoIP = "ENET / DoIP (TCP UDS)"
    case ble = "Bluetooth LE (OBD-II)"

    var id: String { rawValue }
}

@MainActor
@Observable
final class LiveOBDController: NSObject {
    var mode: LiveOBDTransportMode = .simulator
    var isConnected = false
    var statusText = "Bereit"
    var sampleRateHz: Double = 0
    var latestSample: LiveTelemetrySample?
    var availableSerialPorts: [String] = []
    var selectedSerialPort: String = ""
    var enetHost: String = "169.254.250.250"
    var enetPort: String = "6801"
    var discoveredBLEDevices: [String] = []

    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var serialFD: Int32 = -1
    @ObservationIgnored private var nwConnection: NWConnection?
    @ObservationIgnored private var bleCentral: CBCentralManager?
    @ObservationIgnored private var startTime: Date = Date()
    @ObservationIgnored private var sampleCounter: Int = 0

    override init() {
        super.init()
        refreshSerialPorts()
    }

    func refreshSerialPorts() {
        let devURL = URL(fileURLWithPath: "/dev")
        let items = (try? FileManager.default.contentsOfDirectory(atPath: devURL.path)) ?? []
        let ports = items
            .filter { $0.hasPrefix("cu.") && !$0.contains("Bluetooth-Incoming-Port") }
            .sorted()
            .map { "/dev/\($0)" }
        availableSerialPorts = ports
        if selectedSerialPort.isEmpty, let first = ports.first {
            selectedSerialPort = first
        }
    }

    func scanBLE() {
        discoveredBLEDevices = []
        statusText = "Scanne Bluetooth LE OBD-Adapter …"
        if bleCentral == nil {
            bleCentral = CBCentralManager(delegate: self, queue: .main)
        } else if bleCentral?.state == .poweredOn {
            bleCentral?.scanForPeripherals(withServices: nil, options: nil)
        }
    }

    func start(onSample: @escaping @MainActor (LiveTelemetrySample) -> Void) {
        stop()
        isConnected = true
        startTime = Date()
        sampleCounter = 0

        switch mode {
        case .simulator:
            statusText = "Simulator aktiv (20 Hz WOT-Pull)"
            startSimulator(onSample: onSample)
        case .serial:
            startSerial(onSample: onSample)
        case .enetDoIP:
            startENET(onSample: onSample)
        case .ble:
            scanBLE()
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        if serialFD >= 0 {
            close(serialFD)
            serialFD = -1
        }
        nwConnection?.cancel()
        nwConnection = nil
        bleCentral?.stopScan()
        isConnected = false
        sampleRateHz = 0
        statusText = "Getrennt"
    }

    // MARK: - 20 Hz Bench Simulator

    private func startSimulator(onSample: @escaping @MainActor (LiveTelemetrySample) -> Void) {
        streamTask = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                guard let self else { break }
                let t = Double(tick) * 0.05 // 20 Hz
                let cycle = t.truncatingRemainder(dividingBy: 8.0)
                // Smooth 3rd-gear WOT sweep from 1600 -> 6400 rpm and decel
                let phase = cycle < 5.5 ? (cycle / 5.5) : max(0, 1.0 - (cycle - 5.5) / 2.5)
                let rpm = 1600.0 + phase * 4800.0 + sin(t * 7.0) * 18.0
                let load = min(195.0, 28.0 + phase * 155.0 + cos(t * 5.0) * 2.5)
                let mapMbar = 980.0 + phase * 1450.0
                let lambda = 1.0 - phase * 0.21 + sin(t * 9.0) * 0.008
                let ign = 24.0 - phase * 11.5 + (rpm > 4500 ? (rpm - 4500) * 0.003 : 0)
                let speed = 42.0 + phase * 118.0
                let sample = LiveTelemetrySample(
                    timeSec: t, rpm: rpm, loadPct: load, mapMbar: mapMbar,
                    lambda: lambda, ignitionDeg: ign, speedKmh: speed, coolantC: 90.0
                )
                self.latestSample = sample
                self.sampleCounter += 1
                self.sampleRateHz = 20.0
                onSample(sample)
                tick += 1
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        }
    }

    // MARK: - POSIX Serial ELM327 / OBDLink / K+DCAN

    private func startSerial(onSample: @escaping @MainActor (LiveTelemetrySample) -> Void) {
        guard !selectedSerialPort.isEmpty else {
            statusText = "Kein serieller Port ausgewählt."
            isConnected = false
            return
        }
        let fd = open(selectedSerialPort, O_RDWR | O_NOCTTY | O_NONBLOCK)
        guard fd >= 0 else {
            statusText = "Port \(selectedSerialPort) konnte nicht geöffnet werden."
            isConnected = false
            return
        }
        var tio = termios()
        tcgetattr(fd, &tio)
        cfsetispeed(&tio, speed_t(B115200))
        cfsetospeed(&tio, speed_t(B115200))
        tio.c_cflag = tcflag_t(CS8 | CREAD | CLOCAL)
        tio.c_lflag = 0
        tio.c_iflag = 0
        tio.c_oflag = 0
        tcsetattr(fd, TCSANOW, &tio)
        serialFD = fd
        statusText = "Verbunden: \(selectedSerialPort) (115200 Baud)"

        streamTask = Task.detached { [weak self] in
            func send(_ cmd: String) {
                let data = Array((cmd + "\r").utf8)
                _ = write(fd, data, data.count)
            }
            func readLine() -> String {
                var buf = [UInt8](repeating: 0, count: 128)
                let n = read(fd, &buf, buf.count)
                guard n > 0 else { return "" }
                return String(bytes: buf.prefix(n), encoding: .ascii) ?? ""
            }

            // Initialize ELM327
            for initCmd in ["ATZ", "ATE0", "ATL0", "ATSP0"] {
                send(initCmd)
                try? await Task.sleep(nanoseconds: 120_000_000)
                _ = readLine()
            }

            var rpm = 0.0, load = 0.0, map = 1000.0, lam = 1.0, ign = 10.0, spd = 0.0, clt = 85.0
            let start = Date()
            while !Task.isCancelled {
                for cmd in ["010C", "0104", "010B", "010D", "010E", "0144"] {
                    send(cmd)
                    try? await Task.sleep(nanoseconds: 35_000_000)
                    let resp = readLine()
                    let bytes = OBDProtocolDecoder.parseHexLine(resp)
                    if let d = OBDProtocolDecoder.decodeMode01(bytes) {
                        switch d.pid {
                        case 0x0C: rpm = d.value
                        case 0x04: load = d.value
                        case 0x0B: map = d.value
                        case 0x0D: spd = d.value
                        case 0x0E: ign = d.value
                        case 0x44: lam = d.value
                        case 0x05: clt = d.value
                        default: break
                        }
                    }
                }
                let sample = LiveTelemetrySample(
                    timeSec: Date().timeIntervalSince(start),
                    rpm: rpm, loadPct: load, mapMbar: map, lambda: lam,
                    ignitionDeg: ign, speedKmh: spd, coolantC: clt
                )
                await MainActor.run { [weak self] in
                    self?.latestSample = sample
                    self?.sampleRateHz = 4.5
                    onSample(sample)
                }
            }
        }
    }

    // MARK: - Network.framework ENET / DoIP (BMW / VAG UDS 0x22)

    private func startENET(onSample: @escaping @MainActor (LiveTelemetrySample) -> Void) {
        guard let portNum = UInt16(enetPort), let nwPort = NWEndpoint.Port(rawValue: portNum) else {
            statusText = "Ungültiger ENET-Port."
            isConnected = false
            return
        }
        let conn = NWConnection(host: NWEndpoint.Host(enetHost), port: nwPort, using: .tcp)
        nwConnection = conn
        statusText = "Verbinde mit DoIP \(enetHost):\(enetPort) …"

        conn.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                switch state {
                case .ready:
                    self.statusText = "DoIP / ENET verbunden (\(self.enetHost))"
                    self.pollENET(conn: conn, onSample: onSample)
                case .failed(let err):
                    self.statusText = "ENET Fehler: \(err.localizedDescription)"
                    self.isConnected = false
                default:
                    break
                }
            }
        }
        conn.start(queue: .global(qos: .userInitiated))
    }

    private func pollENET(conn: NWConnection, onSample: @escaping @MainActor (LiveTelemetrySample) -> Void) {
        streamTask = Task.detached { [weak self] in
            func receiveDoIPFrame() async -> [UInt8]? {
                await withCheckedContinuation { cont in
                    conn.receive(minimumIncompleteLength: 8, maximumLength: 256) { data, _, _, _ in
                        cont.resume(returning: data.map { [UInt8]($0) })
                    }
                }
            }

            let start = Date()
            var rpm = 0.0, load = 0.0, map = 1000.0, lam = 1.0, ign = 12.0, spd = 0.0, clt = 90.0
            let dids: [UInt16] = [0xF40C, 0xF404, 0xF40B, 0xF444, 0xF40E, 0xF40D, 0xF405]
            while !Task.isCancelled {
                let t0 = Date()
                for did in dids {
                    let req = Data(OBDProtocolDecoder.buildDoIPReadDID(did: did))
                    conn.send(content: req, completion: .idempotent)
                    if let resp = await receiveDoIPFrame(),
                       let decoded = OBDProtocolDecoder.decodeDoIPDiagnosticResponse(resp) {
                        switch decoded.pid {
                        case 0x0C: rpm = decoded.value
                        case 0x04: load = decoded.value
                        case 0x0B: map = decoded.value
                        case 0x44: lam = decoded.value
                        case 0x0E: ign = decoded.value
                        case 0x0D: spd = decoded.value
                        case 0x05: clt = decoded.value
                        default: break
                        }
                    }
                }
                let dt = max(0.05, Date().timeIntervalSince(t0))
                let hz = min(20.0, 1.0 / dt)
                let sample = LiveTelemetrySample(
                    timeSec: Date().timeIntervalSince(start),
                    rpm: rpm, loadPct: load, mapMbar: map, lambda: lam,
                    ignitionDeg: ign, speedKmh: spd, coolantC: clt
                )
                await MainActor.run { [weak self] in
                    self?.latestSample = sample
                    self?.sampleRateHz = hz
                    onSample(sample)
                }
            }
        }
    }
}

extension LiveOBDController: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        Task { @MainActor in
            if central.state == .poweredOn {
                central.scanForPeripherals(withServices: nil, options: nil)
                statusText = "BLE aktiv — suche OBD-Adapter …"
            } else {
                statusText = "Bluetooth nicht bereit (\(central.state.rawValue))"
            }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                                    advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = peripheral.name ?? ""
        guard !name.isEmpty else { return }
        let up = name.uppercased()
        if up.contains("OBD") || up.contains("ELM") || up.contains("VEEPEAK") || up.contains("VLINK") || up.contains("MHD") {
            Task { @MainActor in
                if !discoveredBLEDevices.contains(name) {
                    discoveredBLEDevices.append(name)
                    statusText = "BLE-Adapter gefunden: \(name)"
                }
            }
        }
    }
}
