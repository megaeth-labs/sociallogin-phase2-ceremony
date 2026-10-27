/**
 * A short chime when the participant's turn starts. Many people have system
 * notifications turned off for their browser, so a sound is the alert that
 * reliably reaches someone who switched tabs.
 *
 * Browsers only let a page play sound after a user gesture, so the audio
 * context is created from the opt-in click and reused; once started it keeps
 * working while the tab is in the background.
 */
let context: AudioContext | null = null;

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  const audio = globalThis as unknown as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor };
  return audio.AudioContext ?? audio.webkitAudioContext ?? null;
}

/** Call from the opt-in click. False when this browser cannot play the chime. */
export function enableTurnChime(): boolean {
  const Context = audioContextConstructor();
  if (!Context) return false;
  try {
    context ??= new Context();
    void context.resume();
    return true;
  } catch {
    return false;
  }
}

export function turnChimeEnabled(): boolean {
  return context !== null;
}

/** Two soft rising tones, about half a second in all. False when not enabled. */
export function playTurnChime(): boolean {
  if (!context) return false;
  try {
    void context.resume();
    const start = context.currentTime;
    for (const [index, frequency] of [660, 880].entries()) {
      const at = start + index * 0.18;
      const tone = context.createOscillator();
      const volume = context.createGain();
      tone.type = "sine";
      tone.frequency.value = frequency;
      volume.gain.setValueAtTime(0.0001, at);
      volume.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
      volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      tone.connect(volume).connect(context.destination);
      tone.start(at);
      tone.stop(at + 0.32);
    }
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget the audio context. */
export function resetTurnChimeForTests(): void {
  context = null;
}
