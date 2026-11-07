// astro.js: where the sun and the moon stand, from the feed alone.
//
// The feed carries sunrise and sunset but no coordinates. Solar noon (their midpoint)
// gives the longitude, and the length of the day gives the latitude through
//   cos H0 = (sin h0 - sin φ sin δ) / (cos φ cos δ),   h0 = -0.833°
// so the sky is right wherever the Mac is. Positions use SunCalc's low-precision series
// (about 1°, finer than a pixel of this sky). Near an equinox the day is 12 h long at
// every latitude and φ cannot be solved; the last good value is kept for those weeks.
(function () {
  "use strict";
  const R = Math.PI / 180, J2000 = 2451545, E = 23.4397 * R, H0 = -0.833 * R;
  const days = (t) => t / 86400 + 2440587.5 - J2000;
  const sidereal = (d, lw) => R * (280.16 + 360.9856235 * d) - lw;

  function sun(d) {
    const M = R * (357.5291 + 0.98560028 * d);
    const C = R * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + R * 102.9372 + Math.PI;
    return { ra: Math.atan2(Math.sin(L) * Math.cos(E), Math.cos(L)), dec: Math.asin(Math.sin(E) * Math.sin(L)) };
  }
  function moon(d) {
    const L = R * (218.316 + 13.176396 * d), M = R * (134.963 + 13.064993 * d), F = R * (93.272 + 13.22935 * d);
    const l = L + R * 6.289 * Math.sin(M), b = R * 5.128 * Math.sin(F);
    return {
      ra: Math.atan2(Math.sin(l) * Math.cos(E) - Math.tan(b) * Math.sin(E), Math.cos(l)),
      dec: Math.asin(Math.sin(b) * Math.cos(E) + Math.cos(b) * Math.sin(E) * Math.sin(l)),
      dist: 385001 - 20905 * Math.cos(M),
    };
  }
  // az is measured from south, positive toward the west (SunCalc's convention).
  function altAz(c, d, lw, phi) {
    const H = sidereal(d, lw) - c.ra;
    return {
      az: Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(c.dec) * Math.cos(phi)),
      alt: Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H)),
    };
  }

  let lastLat = null;
  // Longitude west (radians) and latitude from one day's sunrise and sunset.
  function place(rise, set) {
    if (!rise || !set || set <= rise) return null;
    const d = days((rise + set) / 2), s = sun(d);
    let lw = (sidereal(d, 0) - s.ra) % (2 * Math.PI);
    if (lw > Math.PI) lw -= 2 * Math.PI;
    if (lw < -Math.PI) lw += 2 * Math.PI;
    const Hh = (set - rise) / 2 / 86400 * 2 * Math.PI;
    const A = Math.sin(s.dec), B = Math.cos(s.dec) * Math.cos(Hh), Rr = Math.hypot(A, B), al = Math.atan2(B, A);
    let phi = null;
    if (Math.abs(s.dec) > 3 * R && Math.abs(Math.sin(H0) / Rr) <= 1) {
      const a = Math.asin(Math.sin(H0) / Rr);
      for (let c of [a - al, Math.PI - a - al]) {
        while (c > Math.PI) c -= 2 * Math.PI;
        while (c < -Math.PI) c += 2 * Math.PI;
        if (Math.abs(c) <= 66 * R) phi = c;
      }
    }
    if (phi == null) {
      if (lastLat == null) {
        try { lastLat = +localStorage.getItem("horizon.lat") || null; } catch (e) { /* file:// */ }
      }
      phi = lastLat;
    } else if (phi !== lastLat) {
      lastLat = phi;
      try { localStorage.setItem("horizon.lat", String(phi)); } catch (e) { /* file:// */ }
    }
    return phi == null ? null : { lw, phi };
  }

  // Everything the sky needs at time t, or null when the feed has no sun times.
  function sky(t, rise, set) {
    const p = place(rise, set);
    if (!p) return null;
    const d = days(t), s = sun(d), m = moon(d);
    const sp = altAz(s, d, p.lw, p.phi), mp = altAz(m, d, p.lw, p.phi);
    const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
    const inc = Math.atan2(149598000 * Math.sin(phi), m.dist - 149598000 * Math.cos(phi));
    const ang = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra),
      Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
    const fraction = (1 + Math.cos(inc)) / 2;
    const phase = 0.5 + 0.5 * inc * (ang < 0 ? -1 : 1) / Math.PI;     // 0 new, .25 first quarter, .5 full
    // The next moonrise and moonset: step the next 24 h in 10 min, interpolate the crossing.
    const h0 = 0.133 * R;
    let rise2 = null, set2 = null, prev = mp.alt - h0;
    for (let k = 1; k <= 144 && (rise2 == null || set2 == null); k++) {
      const tk = t + k * 600, dk = days(tk);
      const a = altAz(moon(dk), dk, p.lw, p.phi).alt - h0;
      const tc = tk - 600 * a / (a - prev);
      if (prev < 0 && a >= 0 && rise2 == null) rise2 = tc;
      if (prev >= 0 && a < 0 && set2 == null) set2 = tc;
      prev = a;
    }
    const names = ["new moon", "waxing crescent", "first quarter", "waxing gibbous", "full moon",
      "waning gibbous", "last quarter", "waning crescent"];
    return {
      lat: p.phi / R, lon: -p.lw / R,
      sun: { alt: sp.alt / R, az: sp.az / R },
      moon: { alt: mp.alt / R, az: mp.az / R, fraction, phase, name: names[Math.round(phase * 8) % 8], rise: rise2, set: set2 },
    };
  }

  window.HorizonAstro = { sky };
})();
