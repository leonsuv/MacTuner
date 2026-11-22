import Foundation

/// Virtual Road Dyno: computes smoothed WHP / PS and Torque (Nm) curves vs RPM from WOT datalog pulls.
enum VirtualDyno {
    struct VehicleProfile: Identifiable, Hashable {
        var id: String { name }
        var name: String
        var massKg: Double           // curb + driver + fuel
        var gearRatio: Double        // e.g. 3rd/4th gear ratio
        var finalDrive: Double       // differential ratio
        var tireDiameterM: Double    // e.g. 0.635 m (225/40R18)
        var dragCdA: Double          // Cd * Frontal Area (m^2), ~0.68 for compact hatch
        var rollingCoeff: Double     // ~0.015
        var drivetrainLoss: Double   // 0.12 = 12% FWD, 0.18 = 18% AWD
        var ambientTempC: Double     // for SAE J1349 correction
        var baroKPa: Double          // 101.3 kPa sea level

        static let presets: [VehicleProfile] = [
            VehicleProfile(name: "VW Golf / Audi A3 2.0 (3. Gang)", massKg: 1480, gearRatio: 1.47, finalDrive: 3.68,
                           tireDiameterM: 0.635, dragCdA: 0.68, rollingCoeff: 0.015, drivetrainLoss: 0.13, ambientTempC: 20, baroKPa: 101.3),
            VehicleProfile(name: "BMW 335i / 340i (3. Gang)", massKg: 1680, gearRatio: 1.66, finalDrive: 3.15,
                           tireDiameterM: 0.652, dragCdA: 0.64, rollingCoeff: 0.015, drivetrainLoss: 0.15, ambientTempC: 20, baroKPa: 101.3),
            VehicleProfile(name: "Audi S3 / Golf R AWD (3. Gang)", massKg: 1580, gearRatio: 1.47, finalDrive: 3.94,
                           tireDiameterM: 0.635, dragCdA: 0.70, rollingCoeff: 0.015, drivetrainLoss: 0.18, ambientTempC: 20, baroKPa: 101.3),
            VehicleProfile(name: "TDI Kombi / Caddy (3. Gang)", massKg: 1620, gearRatio: 1.38, finalDrive: 3.45,
                           tireDiameterM: 0.645, dragCdA: 0.82, rollingCoeff: 0.016, drivetrainLoss: 0.14, ambientTempC: 20, baroKPa: 101.3),
        ]
    }

    struct DynoPoint: Identifiable {
        let id: Int
        let rpm: Double
        let powerPS: Double
        let torqueNm: Double
    }

    struct DynoResult {
        let points: [DynoPoint]
        let peakPS: Double
        let peakPSRPM: Double
        let peakNm: Double
        let peakNmRPM: Double
        let saeFactor: Double
    }

    static func compute(log: Datalog, rpmChannel: Int, timeChannel: Int?, tpsChannel: Int?,
                        profile: VehicleProfile, sampleRateHz: Double = 10.0) -> DynoResult? {
        guard log.frameCount >= 10, rpmChannel >= 0, rpmChannel < log.channels.count else { return nil }

        // Extract longest monotonic WOT/accelerating RPM pull
        var bestRun: [(t: Double, rpm: Double)] = []
        var curRun: [(t: Double, rpm: Double)] = []

        for f in 0..<log.frameCount {
            guard let rpm = log.value(frame: f, channel: rpmChannel), rpm >= 1200 else {
                if curRun.count > bestRun.count { bestRun = curRun }
                curRun = []
                continue
            }
            if let tc = tpsChannel, let tps = log.value(frame: f, channel: tc), tps < 70 {
                if curRun.count > bestRun.count { bestRun = curRun }
                curRun = []
                continue
            }
            let t: Double
            if let timeCh = timeChannel, let tv = log.value(frame: f, channel: timeCh) {
                t = tv
            } else {
                t = Double(f) / max(1.0, sampleRateHz)
            }
            if let prev = curRun.last, rpm < prev.rpm - 80 || t <= prev.t {
                if curRun.count > bestRun.count { bestRun = curRun }
                curRun = [(t, rpm)]
            } else {
                curRun.append((t, rpm))
            }
        }
        if curRun.count > bestRun.count { bestRun = curRun }
        guard bestRun.count >= 6 else { return nil }

        // Smooth RPM with 5-point moving average to suppress sensor jitter
        let n = bestRun.count
        var smoothRPM = [Double](repeating: 0, count: n)
        for i in 0..<n {
            let lo = max(0, i - 2), hi = min(n - 1, i + 2)
            var sum = 0.0
            for k in lo...hi { sum += bestRun[k].rpm }
            smoothRPM[i] = sum / Double(hi - lo + 1)
        }

        let overallRatio = max(0.5, profile.gearRatio * profile.finalDrive)
        let wheelCirc = Double.pi * profile.tireDiameterM
        // Air density rho = P / (R_specific * T)
        let rho = (profile.baroKPa * 1000.0) / (287.05 * (profile.ambientTempC + 273.15))
        // SAE J1349 atmospheric correction factor
        let sae = 1.18 * (99.0 / max(70.0, profile.baroKPa)) * sqrt((profile.ambientTempC + 273.15) / 298.15) - 0.18
        let clampedSAE = min(max(sae, 0.85), 1.25)

        var rawPts: [(rpm: Double, ps: Double, nm: Double)] = []
        for i in 1..<(n - 1) {
            let dt = bestRun[i + 1].t - bestRun[i - 1].t
            guard dt > 0.02 else { continue }
            let v0 = (smoothRPM[i - 1] / 60.0 / overallRatio) * wheelCirc
            let v1 = (smoothRPM[i + 1] / 60.0 / overallRatio) * wheelCirc
            let v = (smoothRPM[i] / 60.0 / overallRatio) * wheelCirc
            let accel = (v1 - v0) / dt
            guard accel > 0.1 else { continue }

            let fAccel = profile.massKg * accel
            let fAero = 0.5 * rho * profile.dragCdA * v * v
            let fRoll = profile.rollingCoeff * profile.massKg * 9.81
            let wheelWatts = (fAccel + fAero + fRoll) * v
            let crankWatts = (wheelWatts / max(0.5, 1.0 - profile.drivetrainLoss)) * clampedSAE
            let ps = crankWatts / 735.49875
            let omega = smoothRPM[i] * 2.0 * Double.pi / 60.0
            let nm = omega > 1 ? (crankWatts / omega) : 0
            if ps > 10 && ps < 2000 && nm > 10 && nm < 2500 {
                rawPts.append((smoothRPM[i], ps, nm))
            }
        }
        guard !rawPts.isEmpty else { return nil }

        // Final 3-point curve smoothing
        var pts: [DynoPoint] = []
        var peakPS = 0.0, peakPSRPM = 0.0, peakNm = 0.0, peakNmRPM = 0.0
        for i in 0..<rawPts.count {
            let lo = max(0, i - 1), hi = min(rawPts.count - 1, i + 1)
            var psSum = 0.0, nmSum = 0.0
            for k in lo...hi { psSum += rawPts[k].ps; nmSum += rawPts[k].nm }
            let c = Double(hi - lo + 1)
            let ps = psSum / c, nm = nmSum / c, rpm = rawPts[i].rpm
            if ps > peakPS { peakPS = ps; peakPSRPM = rpm }
            if nm > peakNm { peakNm = nm; peakNmRPM = rpm }
            pts.append(DynoPoint(id: i, rpm: rpm, powerPS: ps, torqueNm: nm))
        }
        return DynoResult(points: pts, peakPS: peakPS, peakPSRPM: peakPSRPM,
                          peakNm: peakNm, peakNmRPM: peakNmRPM, saeFactor: clampedSAE)
    }
}
