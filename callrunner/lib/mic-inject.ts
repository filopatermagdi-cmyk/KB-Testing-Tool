// Browser-injected mic override. This function is serialized to the page via
// fn.toString() (Playwright addInitScript), so it MUST stay self-contained: it can
// reference only browser globals, never module variables — that's why 16 kHz etc.
// are inline. tsx/esbuild wraps its inner functions in __name(...); call.ts injects
// a __name shim before this so the serialized code doesn't throw. It sets
// window.__cr.installed = true as its LAST line so call.ts can verify the override
// actually installed (otherwise the call silently records the browser fake device).
export function micOverrideInit() {
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  // Use the browser's NATIVE context rate (typically 48 kHz) — do NOT force it to
  // 16 kHz. createBuffer() below resamples the 16k clips up to the context rate, so
  // the mic track we hand WebRTC runs at the rate the getUserMedia/WebRTC pipeline
  // and the server recorder expect. A prior "force 16 kHz" experiment produced a
  // 16 kHz track the server mishandled — the recording came back as fast, tonal
  // chirping instead of the actual voice. Match the pipeline; let it downsample.
  const ctx: AudioContext = new AC();
  const dest = ctx.createMediaStreamDestination();
  const buffers: Record<number, AudioBuffer> = {};
  (window as any).__cr = {
    load(index: number, b64: string, sampleRate: number) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const view = new DataView(bytes.buffer);
      const n = (bytes.length / 2) | 0;
      const buf = ctx.createBuffer(1, n, sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
      buffers[index] = buf;
    },
    async playClip(index: number) {
      if (ctx.state !== 'running') {
        try {
          await ctx.resume();
        } catch {}
      }
      const buf = buffers[index];
      if (!buf) throw new Error('clip not loaded: ' + index);
      return new Promise((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(dest);
        src.onended = () => resolve(Math.round(buf.duration * 1000));
        src.start();
      });
    },
  };
  const md = navigator.mediaDevices;
  const orig = md && md.getUserMedia ? md.getUserMedia.bind(md) : null;
  const fake = async (constraints: any) => {
    if (constraints && constraints.audio) {
      if (ctx.state !== 'running') {
        try {
          await ctx.resume();
        } catch {}
      }
      return dest.stream;
    }
    return orig ? orig(constraints) : Promise.reject(new Error('no getUserMedia'));
  };
  if (md) (md as any).getUserMedia = fake;
  // Some libs read the legacy navigator.getUserMedia — cover it too.
  (navigator as any).getUserMedia = (c: any, ok: any, err: any) => fake(c).then(ok, err);
  // Set LAST, only after the overrides above are in place. attempt() checks this
  // before starting the call, so a silently-broken injection (e.g. a transpiler
  // helper that fails to serialize into the page) fails loud instead of letting the
  // call record the browser's fake device. Note: window.__cr is assigned earlier,
  // so its existence alone does NOT prove the override installed — this flag does.
  (window as any).__cr.installed = true;
}
