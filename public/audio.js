// Moteur audio : capture micro -> PCM 16 bits 16 kHz, et lecture avec un léger effet "radio".
const RATE = 16000;

export class RadioAudio {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.transmitting = false;
    this.onChunk = null;
    this.next = new Map(); // userId -> heure de lecture prévue
    this.volume = 1;
  }

  // À appeler sur un geste utilisateur (obligatoire sur mobile)
  async unlock() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.out = this.ctx.createGain();
      // Filtre passe-bande pour le son "talkie-walkie"
      this.hp = this.ctx.createBiquadFilter();
      this.hp.type = 'highpass';
      this.hp.frequency.value = 300;
      this.lp = this.ctx.createBiquadFilter();
      this.lp.type = 'lowpass';
      this.lp.frequency.value = 3400;
      this.hp.connect(this.lp).connect(this.out).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  setVolume(v) {
    this.volume = v;
    if (this.out) this.out.gain.value = v;
  }

  async ensureMic() {
    await this.unlock();
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Micro indisponible (le site doit être en HTTPS ou sur localhost)');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await this.ctx.audioWorklet.addModule('/mic-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.ctx, 'mic-capture');
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(node).connect(mute).connect(this.ctx.destination);
    node.port.onmessage = (e) => {
      if (this.transmitting && this.onChunk) this.onChunk(this.encode(e.data));
    };
  }

  // Float32 (taux du navigateur) -> Int16 à 16 kHz
  encode(input) {
    const ratio = this.ctx.sampleRate / RATE;
    const len = Math.floor(input.length / ratio);
    const out = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      const start = Math.floor(i * ratio), end = Math.floor((i + 1) * ratio);
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      const s = Math.max(-1, Math.min(1, sum / (end - start || 1)));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out.buffer;
  }

  play(userId, arrayBuffer) {
    if (!this.ctx) return;
    const pcm = new Int16Array(arrayBuffer);
    if (!pcm.length) return;
    const buf = this.ctx.createBuffer(1, pcm.length, RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.hp);
    const now = this.ctx.currentTime;
    let t = this.next.get(userId) || 0;
    if (t < now + 0.05) t = now + 0.12; // petit tampon anti-coupures
    src.start(t);
    this.next.set(userId, t + buf.duration);
  }

  endOf(userId) {
    const t = this.next.get(userId) || 0;
    this.next.delete(userId);
    return Math.max(0, t - (this.ctx?.currentTime || 0));
  }

  // Bruit blanc court (ouverture du canal)
  squelch(duration = 0.12, delay = 0) {
    if (!this.ctx) return;
    const n = Math.floor(this.ctx.sampleRate * duration);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * 0.25 * (1 - i / n);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.hp);
    src.start(this.ctx.currentTime + delay);
  }

  // Bip "roger" de fin de transmission
  beep(delay = 0, freqs = [1200, 900]) {
    if (!this.ctx) return;
    let t = this.ctx.currentTime + delay;
    for (const f of freqs) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.08, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      o.connect(g).connect(this.out);
      o.start(t);
      o.stop(t + 0.1);
      t += 0.1;
    }
  }
}
