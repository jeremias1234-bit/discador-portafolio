// Documento oculto que hace sonar los avisos: dos tonos cortos para el IVR y tres más agudos y
// fuertes para los leads del bot de WhatsApp, así se distinguen sin mirar la pantalla.
const TONOS = {
  ivr: { frecuencias: [880, 1175], volumen: 0.4 },
  lead: { frecuencias: [1047, 1319, 1568], volumen: 0.6 },
};

chrome.runtime.onMessage.addListener((m) => {
  if (m?.tipo !== 'sonar') return;
  const { frecuencias, volumen } = TONOS[m.estilo] ?? TONOS.ivr;
  const ctx = new AudioContext();
  frecuencias.forEach((frecuencia, i) => {
    const inicio = i * 0.22;
    const osc = ctx.createOscillator();
    const vol = ctx.createGain();
    osc.frequency.value = frecuencia;
    vol.gain.setValueAtTime(0.0001, ctx.currentTime + inicio);
    vol.gain.exponentialRampToValueAtTime(volumen, ctx.currentTime + inicio + 0.02);
    vol.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + inicio + 0.2);
    osc.connect(vol).connect(ctx.destination);
    osc.start(ctx.currentTime + inicio);
    osc.stop(ctx.currentTime + inicio + 0.22);
  });
  setTimeout(() => void ctx.close(), 1500);
});
