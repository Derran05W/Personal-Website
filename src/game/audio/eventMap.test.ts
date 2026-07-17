import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGameStore } from '../state/store';
import { gameEvents, type GameEventMap } from '../state/events';
import { AUDIO_BUSES, AUDIO_MIX } from '../config/audio';
import {
  setAudioContextFactory,
  __resetAudioManagerForTest,
  unlockAudioContext,
  liveVoiceCount,
  getBusNode,
} from './manager';
import { SOUND_NAMES as REAL_SOUND_NAMES, type SoundBuilder as SynthBuilder, type SoundParams as SynthSoundParams } from './synth';
import {
  EVENT_SOUND_DOC,
  SOUND_NAMES,
  registerAdapter,
  registerAllEventSounds,
  isRegistered,
  playEvent,
  playTransformerSequence,
  startEngineLoop,
  stopEngineLoop,
  setAmbience,
  stopAmbience,
  getAmbience,
  nextAmbience,
  stopAllLoops,
  duckSfxBus,
  stingerForTier,
  selectExplosionSound,
  shouldPlayGunshot,
  nextImpactVariant,
  getEventMapSnapshot,
  initEventMap,
  __resetEventMapForTest,
} from './eventMap';

// jsdom has no Web Audio implementation (same constraint documented in audio/sirens.ts,
// audio/manager.ts and audio/synth.ts's file headers). This suite splits along that same
// line: pure decision logic (mapping/rate-limit/reducer functions) is asserted directly;
// everything that touches a real graph goes through manager.ts's injectable
// `setAudioContextFactory` seam. Two levels of fake are used —
//   1. A handful of tests use small hand-rolled `SoundBuilder` fakes (no real oscillators) to
//      exercise THIS file's own adapter/pool/bus/loop-bookkeeping wiring in isolation.
//   2. The "real synth builders" group at the bottom registers the ACTUAL audio/synth.ts
//      library against a fuller WebAudio node fake, to catch a signature/shape mismatch
//      between this file's adapter and synth.ts's real builders that a hand-rolled fake
//      builder could never reveal.

// --- fake WebAudio graph (superset of manager.test.ts's minimal fake — this file also drives
// the real synth.ts builders, which additionally need oscillators/filters/buffer sources) ----
class FakeAudioParam {
  value = 0;
  cancelScheduledValues = vi.fn(() => this);
  setValueAtTime = vi.fn((v: number) => {
    this.value = v;
    return this;
  });
  linearRampToValueAtTime = vi.fn((v: number) => {
    this.value = v;
    return this;
  });
  exponentialRampToValueAtTime = vi.fn((v: number) => {
    this.value = v;
    return this;
  });
  setTargetAtTime = vi.fn((v: number) => {
    this.value = v;
    return this;
  });
}

class FakeAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
}

class FakeBiquadFilterNode extends FakeAudioNode {
  type = 'lowpass';
  frequency = new FakeAudioParam();
  Q = new FakeAudioParam();
  detune = new FakeAudioParam();
}

class FakeOscillatorNode extends FakeAudioNode {
  type = 'sine';
  frequency = new FakeAudioParam();
  detune = new FakeAudioParam();
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioBufferSourceNode extends FakeAudioNode {
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
}

class FakeAudioContext {
  currentTime = 0;
  sampleRate = 44100;
  destination = {} as AudioDestinationNode;
  state: AudioContextState = 'running';
  createGain(): GainNode {
    return new FakeGainNode() as unknown as GainNode;
  }
  createBiquadFilter(): BiquadFilterNode {
    return new FakeBiquadFilterNode() as unknown as BiquadFilterNode;
  }
  createOscillator(): OscillatorNode {
    return new FakeOscillatorNode() as unknown as OscillatorNode;
  }
  createBufferSource(): AudioBufferSourceNode {
    return new FakeAudioBufferSourceNode() as unknown as AudioBufferSourceNode;
  }
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    const data = new Float32Array(Math.max(1, length));
    return {
      getChannelData: () => data,
      length,
      sampleRate,
      numberOfChannels: channels,
    } as unknown as AudioBuffer;
  }
  close = vi.fn(async () => {
    this.state = 'closed';
  });
}

function fakeContextFactory(): AudioContext | null {
  return new FakeAudioContext() as unknown as AudioContext;
}

// --- hand-rolled synth.SoundBuilder fake (no real oscillators) — for testing THIS file's own
// adapter wiring against manager.ts's real pool, independent of synth.ts's real graphs. -------
interface FakeVoiceHandle {
  start: ReturnType<typeof vi.fn<(when?: number) => void>>;
  stop: ReturnType<typeof vi.fn<(when?: number) => void>>;
  onEnded?: () => void;
}

function makeFakeSynthBuilder(): {
  build: SynthBuilder;
  handles: FakeVoiceHandle[];
  paramsSeen: (SynthSoundParams | undefined)[];
} {
  const handles: FakeVoiceHandle[] = [];
  const paramsSeen: (SynthSoundParams | undefined)[] = [];
  const build: SynthBuilder = (_ctx, _destination, params) => {
    paramsSeen.push(params);
    const handle: FakeVoiceHandle = {
      start: vi.fn<(when?: number) => void>(),
      stop: vi.fn<(when?: number) => void>(),
      onEnded: undefined,
    };
    handles.push(handle);
    return handle;
  };
  return { build, handles, paramsSeen };
}

const initialStoreState = useGameStore.getState();

beforeEach(() => {
  localStorage.clear();
  useGameStore.setState(initialStoreState, true);
  __resetAudioManagerForTest();
  __resetEventMapForTest();
  setAudioContextFactory(fakeContextFactory);
  // registerSound (manager.ts) dev-warns on re-registering a name — expected constantly in
  // this file (most tests re-register real SoundNames with a fresh fake builder), so it's
  // silenced rather than left to spam every test's output.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetAudioManagerForTest();
  __resetEventMapForTest();
});

// ================================================================================================
// Pure mapping / reducer helpers
// ================================================================================================

describe('stingerForTier', () => {
  it('maps tiers 1-5 to stingerTier{n}', () => {
    for (let t = 1; t <= 5; t++) expect(stingerForTier(t)).toBe(`stingerTier${t}`);
  });

  it('returns null outside 1..5', () => {
    expect(stingerForTier(0)).toBeNull();
    expect(stingerForTier(6)).toBeNull();
    expect(stingerForTier(-1)).toBeNull();
  });

  it('truncates a fractional tier', () => {
    expect(stingerForTier(3.9)).toBe('stingerTier3');
  });
});

describe('selectExplosionSound', () => {
  it('picks near at/under the radius, far strictly beyond it', () => {
    expect(selectExplosionSound(0)).toBe('explosionNear');
    expect(selectExplosionSound(AUDIO_MIX.explosionNearRadiusM)).toBe('explosionNear');
    expect(selectExplosionSound(AUDIO_MIX.explosionNearRadiusM + 0.01)).toBe('explosionFar');
  });

  it('honors an overridden radius', () => {
    expect(selectExplosionSound(10, 5)).toBe('explosionFar');
    expect(selectExplosionSound(5, 5)).toBe('explosionNear');
  });
});

describe('shouldPlayGunshot', () => {
  it('is false before minIntervalMs has elapsed, true at/after', () => {
    const min = AUDIO_MIX.gunshotMinIntervalMs;
    expect(shouldPlayGunshot(1000, 1000 + min - 1)).toBe(false);
    expect(shouldPlayGunshot(1000, 1000 + min)).toBe(true);
  });

  it('is true on the very first call (an infinitely-stale "last played")', () => {
    expect(shouldPlayGunshot(-Infinity, 0)).toBe(true);
  });
});

describe('nextImpactVariant', () => {
  it('cycles 0..3 deterministically', () => {
    const seq = Array.from({ length: 9 }, () => nextImpactVariant());
    expect(seq).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0]);
  });
});

describe('nextAmbience', () => {
  it('darkCity -> crickets, runStarted -> city (a retry after DARK CITY relights)', () => {
    expect(nextAmbience('darkCity')).toBe('ambienceCrickets');
    expect(nextAmbience('runStarted')).toBe('ambienceCity');
  });
});

describe('EVENT_SOUND_DOC', () => {
  const expectedKeys: (keyof GameEventMap)[] = [
    'heatChanged',
    'tierChanged',
    'transformerDestroyed',
    'unitWrecked',
    'civHit',
    'civWrecked',
    'propDestroyed',
    'playerDamaged',
    'playerWrecked',
    'busted',
    'runStarted',
    'runEnded',
    'darkCity',
    'enteredWater',
    'carUnlocked',
  ];

  it('documents every GameEventMap key exactly once, with a non-empty description', () => {
    expect(Object.keys(EVENT_SOUND_DOC).sort()).toEqual([...expectedKeys].sort());
    for (const key of expectedKeys) expect(EVENT_SOUND_DOC[key].length).toBeGreaterThan(0);
  });
});

describe('SOUND_NAMES / AUDIO_MIX.priority coverage', () => {
  it('re-exports synth.ts\'s registration order unchanged', () => {
    expect(SOUND_NAMES).toEqual(REAL_SOUND_NAMES);
  });

  it('AUDIO_MIX.priority has a numeric entry for every SoundName (compile-time enforced by this file\'s Record<SoundName,X> tables; this is the runtime belt-and-suspenders check)', () => {
    for (const name of SOUND_NAMES) expect(typeof AUDIO_MIX.priority[name]).toBe('number');
  });
});

// ================================================================================================
// Registration adapter — manager.ts's REAL pool, small fake SoundBuilder functions.
// ================================================================================================

describe('registerAdapter', () => {
  it('acquires a pool voice, connects the gateway to the assigned bus, and starts the synth voice', () => {
    unlockAudioContext();
    const { build, handles } = makeFakeSynthBuilder();
    registerAdapter('impact', build, 'impact', 'sfx', 1);

    playEvent('impact', { velocity: 0.5 });

    expect(handles).toHaveLength(1);
    expect(handles[0].start).toHaveBeenCalledTimes(1);
    expect(liveVoiceCount('impact')).toBe(1);
  });

  it('releases the pool slot when the synth voice fires onEnded (natural end)', () => {
    unlockAudioContext();
    const { build, handles } = makeFakeSynthBuilder();
    registerAdapter('impact', build, 'impact', 'sfx', 1);

    playEvent('impact');
    expect(liveVoiceCount('impact')).toBe(1);

    handles[0].onEnded?.();
    expect(liveVoiceCount('impact')).toBe(0);
  });

  it('is a silent no-op if the pool refuses (at cap, not higher priority)', () => {
    unlockAudioContext();
    const { build, handles } = makeFakeSynthBuilder();
    registerAdapter('impact', build, 'impact', 'sfx', 1);
    for (let i = 0; i < 6; i++) playEvent('impact'); // fills the impact cap (6)
    expect(handles).toHaveLength(6);

    expect(() => playEvent('impact')).not.toThrow();
    expect(handles).toHaveLength(6); // 7th refused — no new voice, no crash
    expect(liveVoiceCount('impact')).toBe(6);
  });

  it('evicts the lowest-priority voice in the group for a strictly higher-priority acquire, and stops its synth voice', () => {
    unlockAudioContext();
    const { build, handles } = makeFakeSynthBuilder();
    registerAdapter('gunshot', build, 'gun', 'sfx', AUDIO_MIX.priority.gunshot);
    registerAdapter('shellLaunch', build, 'gun', 'sfx', AUDIO_MIX.priority.shellLaunch);

    for (let i = 0; i < 4; i++) playEvent('gunshot'); // fills the gun cap (4) at priority 1
    expect(liveVoiceCount('gun')).toBe(4);

    playEvent('shellLaunch'); // priority 2 > 1 — evicts the oldest gunshot voice

    expect(liveVoiceCount('gun')).toBe(4); // one evicted, one added — still at cap
    expect(handles[0].stop).toHaveBeenCalledTimes(1); // the evicted (oldest) voice was stopped
  });
});

// ================================================================================================
// Loop control (engine + ambience swap + stopAllLoops)
// ================================================================================================

describe('loop control', () => {
  it('startEngineLoop/stopEngineLoop track exactly one loop voice, idempotently', () => {
    unlockAudioContext();
    const { build, handles } = makeFakeSynthBuilder();
    registerAdapter('engine', build, 'loop', 'engine', 1);

    startEngineLoop();
    startEngineLoop(); // double-start — no-op, still exactly one voice (TDD §11 gotcha)
    expect(handles).toHaveLength(1);
    expect(getEventMapSnapshot().activeLoops).toEqual(['engine']);

    stopEngineLoop();
    expect(handles[0].stop).toHaveBeenCalledTimes(1);
    expect(getEventMapSnapshot().activeLoops).toEqual([]);

    stopEngineLoop(); // already stopped — no-op, doesn't double-call stop()
    expect(handles[0].stop).toHaveBeenCalledTimes(1);
  });

  it('setAmbience swaps city<->crickets, stopping the previous bed; repeating the same name no-ops', () => {
    unlockAudioContext();
    const city = makeFakeSynthBuilder();
    const crickets = makeFakeSynthBuilder();
    registerAdapter('ambienceCity', city.build, 'loop', 'ambient', 1);
    registerAdapter('ambienceCrickets', crickets.build, 'loop', 'ambient', 1);

    setAmbience('ambienceCity');
    expect(getAmbience()).toBe('ambienceCity');
    expect(city.handles).toHaveLength(1);

    setAmbience('ambienceCity'); // same bed already playing — no-op
    expect(city.handles).toHaveLength(1);

    setAmbience('ambienceCrickets');
    expect(getAmbience()).toBe('ambienceCrickets');
    expect(city.handles[0].stop).toHaveBeenCalledTimes(1);
    expect(crickets.handles).toHaveLength(1);

    stopAmbience();
    expect(crickets.handles[0].stop).toHaveBeenCalledTimes(1);
    expect(getAmbience()).toBeNull();
  });

  it('stopAllLoops stops every tracked loop and resets ambience bookkeeping', () => {
    unlockAudioContext();
    const engine = makeFakeSynthBuilder();
    const city = makeFakeSynthBuilder();
    registerAdapter('engine', engine.build, 'loop', 'engine', 1);
    registerAdapter('ambienceCity', city.build, 'loop', 'ambient', 1);

    startEngineLoop();
    setAmbience('ambienceCity');
    expect(getEventMapSnapshot().activeLoops.slice().sort()).toEqual(['ambienceCity', 'engine']);

    stopAllLoops();

    expect(engine.handles[0].stop).toHaveBeenCalledTimes(1);
    expect(city.handles[0].stop).toHaveBeenCalledTimes(1);
    expect(getEventMapSnapshot().activeLoops).toEqual([]);
    expect(getAmbience()).toBeNull();
  });
});

// ================================================================================================
// Duck envelope
// ================================================================================================

describe('duckSfxBus', () => {
  it('is a silent no-op before the context exists', () => {
    expect(() => duckSfxBus()).not.toThrow();
  });

  it('ramps the sfx bus down to amount*target then back up to target, around the resolved PLAYING gain', () => {
    useGameStore.setState({ machine: 'PLAYING' });
    unlockAudioContext();
    const sfxBus = getBusNode('sfx') as unknown as FakeGainNode;

    duckSfxBus();

    const target = AUDIO_BUSES.sfxGain; // resolveBusTargets('PLAYING').sfx === AUDIO_BUSES.sfxGain
    expect(sfxBus.gain.linearRampToValueAtTime).toHaveBeenNthCalledWith(
      1,
      target * AUDIO_MIX.duck.amount,
      expect.any(Number),
    );
    expect(sfxBus.gain.linearRampToValueAtTime).toHaveBeenNthCalledWith(2, target, expect.any(Number));
  });
});

// ================================================================================================
// Transformer sequence: zap immediately, whoomp after the configured delay.
// ================================================================================================

describe('playTransformerSequence', () => {
  it('plays the zap immediately and the whoomp after AUDIO_MIX.transformerWhoompDelayMs', () => {
    vi.useFakeTimers();
    unlockAudioContext();
    const zap = makeFakeSynthBuilder();
    const whoomp = makeFakeSynthBuilder();
    registerAdapter('transformerZap', zap.build, 'impact', 'sfx', AUDIO_MIX.priority.transformerZap);
    registerAdapter('powerDownWhoomp', whoomp.build, 'impact', 'sfx', AUDIO_MIX.priority.powerDownWhoomp);

    playTransformerSequence();
    expect(zap.handles).toHaveLength(1);
    expect(whoomp.handles).toHaveLength(0);

    vi.advanceTimersByTime(AUDIO_MIX.transformerWhoompDelayMs);
    expect(whoomp.handles).toHaveLength(1);
  });

  it('a second transformerDestroyed before the first whoomp lands reschedules rather than doubling it', () => {
    vi.useFakeTimers();
    unlockAudioContext();
    const zap = makeFakeSynthBuilder();
    const whoomp = makeFakeSynthBuilder();
    registerAdapter('transformerZap', zap.build, 'impact', 'sfx', 1);
    registerAdapter('powerDownWhoomp', whoomp.build, 'impact', 'sfx', 1);

    playTransformerSequence();
    vi.advanceTimersByTime(AUDIO_MIX.transformerWhoompDelayMs / 2);
    playTransformerSequence(); // a second district dies mid-delay
    vi.advanceTimersByTime(AUDIO_MIX.transformerWhoompDelayMs / 2);
    expect(whoomp.handles).toHaveLength(0); // first whoomp was cleared, not yet due again

    vi.advanceTimersByTime(AUDIO_MIX.transformerWhoompDelayMs / 2);
    expect(whoomp.handles).toHaveLength(1); // second sequence's whoomp lands on schedule
    expect(zap.handles).toHaveLength(2); // both zaps played (never debounced, only the whoomp is)
  });
});

// ================================================================================================
// initEventMap: gameEvents subscription wiring (fake SoundBuilder per assertion — isolates the
// ROUTING logic from synth.ts's real graphs, which get their own dedicated group below).
// ================================================================================================

describe('initEventMap: event routing', () => {
  it('civHit/civWrecked/propDestroyed/unitWrecked/enteredWater all route through impact with a velocity trim + round-robin variant', () => {
    unlockAudioContext();
    const teardown = initEventMap(); // registers the REAL library first...
    const impact = makeFakeSynthBuilder();
    registerAdapter('impact', impact.build, 'impact', 'sfx', AUDIO_MIX.priority.impact); // ...then this overrides just 'impact'.

    gameEvents.emit('civHit', {});
    gameEvents.emit('civWrecked', {});
    gameEvents.emit('propDestroyed', { archetype: 'trashCan' });
    gameEvents.emit('unitWrecked', { unitKind: 'police' });
    gameEvents.emit('enteredWater', {});

    expect(impact.paramsSeen.map((p) => p?.velocity)).toEqual([0.4, 0.7, 0.7, 0.8, 0.3]);
    expect(impact.paramsSeen.map((p) => p?.variant)).toEqual([0, 1, 2, 3, 0]);

    teardown();
  });

  it('tierChanged fires the matching stingerTier{n} and ducks the sfx bus; heatChanged fires nothing', () => {
    useGameStore.setState({ machine: 'PLAYING' });
    unlockAudioContext();
    const teardown = initEventMap();
    const stinger3 = makeFakeSynthBuilder();
    registerAdapter('stingerTier3', stinger3.build, 'stinger', 'sfx', AUDIO_MIX.priority.stingerTier3);
    const sfxBus = getBusNode('sfx') as unknown as FakeGainNode;
    sfxBus.gain.linearRampToValueAtTime.mockClear();

    gameEvents.emit('heatChanged', { heat: 5, delta: 5 });
    expect(sfxBus.gain.linearRampToValueAtTime).not.toHaveBeenCalled(); // no duck, no sound

    gameEvents.emit('tierChanged', { tier: 3, prevTier: 2 });
    expect(stinger3.handles).toHaveLength(1);
    expect(sfxBus.gain.linearRampToValueAtTime).toHaveBeenCalled(); // duck ramp happened

    teardown();
  });

  it('playerWrecked/busted fire their stingers; playerDamaged fires nothing', () => {
    unlockAudioContext();
    const teardown = initEventMap();
    const wrecked = makeFakeSynthBuilder();
    const busted = makeFakeSynthBuilder();
    registerAdapter('stingerWrecked', wrecked.build, 'stinger', 'sfx', AUDIO_MIX.priority.stingerWrecked);
    registerAdapter('stingerBusted', busted.build, 'stinger', 'sfx', AUDIO_MIX.priority.stingerBusted);

    gameEvents.emit('playerDamaged', { hp: 50, amount: 10 });
    gameEvents.emit('playerWrecked', {});
    gameEvents.emit('busted', {});

    expect(wrecked.handles).toHaveLength(1);
    expect(busted.handles).toHaveLength(1);

    teardown();
  });

  it('transformerDestroyed routes through the zap/whoomp sequence', () => {
    vi.useFakeTimers();
    unlockAudioContext();
    const teardown = initEventMap();
    const zap = makeFakeSynthBuilder();
    const whoomp = makeFakeSynthBuilder();
    registerAdapter('transformerZap', zap.build, 'impact', 'sfx', AUDIO_MIX.priority.transformerZap);
    registerAdapter('powerDownWhoomp', whoomp.build, 'impact', 'sfx', AUDIO_MIX.priority.powerDownWhoomp);

    gameEvents.emit('transformerDestroyed', { districtId: 2 });
    expect(zap.handles).toHaveLength(1);
    vi.advanceTimersByTime(AUDIO_MIX.transformerWhoompDelayMs);
    expect(whoomp.handles).toHaveLength(1);

    teardown();
  });

  it('runEnded cancels a pending transformer whoomp (no orphaned setTimeout after teardown)', () => {
    vi.useFakeTimers();
    unlockAudioContext();
    const teardown = initEventMap();
    const whoomp = makeFakeSynthBuilder();
    registerAdapter('powerDownWhoomp', whoomp.build, 'impact', 'sfx', 3);

    gameEvents.emit('transformerDestroyed', { districtId: 0 });
    gameEvents.emit('runEnded', { score: 0, reason: 'wrecked' });
    vi.advanceTimersByTime(AUDIO_MIX.transformerWhoompDelayMs * 2);

    expect(whoomp.handles).toHaveLength(0); // cleared by runEnded, never fired

    teardown();
  });
});

// ================================================================================================
// Real synth.ts builders — structural smoke test. Catches an adapter<->synth.ts signature
// mismatch that a hand-rolled fake SoundBuilder could never reveal.
// ================================================================================================

describe('initEventMap + the real synth.ts library (structural smoke)', () => {
  it('registers every SoundName without throwing', () => {
    unlockAudioContext();
    expect(isRegistered()).toBe(false);
    expect(() => registerAllEventSounds()).not.toThrow();
    expect(isRegistered()).toBe(true);
  });

  it('runStarted starts the engine + city ambience loop through the REAL builders; runEnded stops both', () => {
    useGameStore.setState({ machine: 'PLAYING' });
    unlockAudioContext();
    const teardown = initEventMap();

    gameEvents.emit('runStarted', { seed: 1 });
    const started = getEventMapSnapshot();
    expect(started.activeLoops.slice().sort()).toEqual(['ambienceCity', 'engine']);
    expect(getAmbience()).toBe('ambienceCity');

    gameEvents.emit('runEnded', { score: 0, reason: 'wrecked' });
    expect(getEventMapSnapshot().activeLoops).toEqual([]);
    expect(getAmbience()).toBeNull();

    teardown();
  });

  it('darkCity swaps to crickets through the real builder; a fresh runStarted resets to city', () => {
    useGameStore.setState({ machine: 'PLAYING' });
    unlockAudioContext();
    const teardown = initEventMap();

    gameEvents.emit('runStarted', { seed: 1 });
    gameEvents.emit('darkCity', {});
    expect(getAmbience()).toBe('ambienceCrickets');
    expect(getEventMapSnapshot().activeLoops).toContain('ambienceCrickets');

    gameEvents.emit('runStarted', { seed: 2 }); // retry after DARK CITY
    expect(getAmbience()).toBe('ambienceCity');

    teardown();
  });

  it('firing every catalog event once (the debug board\'s "spam test" shape) never throws', () => {
    useGameStore.setState({ machine: 'PLAYING' });
    unlockAudioContext();
    const teardown = initEventMap();

    expect(() => {
      gameEvents.emit('runStarted', { seed: 1 });
      gameEvents.emit('heatChanged', { heat: 1, delta: 1 });
      gameEvents.emit('tierChanged', { tier: 1, prevTier: 0 });
      gameEvents.emit('tierChanged', { tier: 5, prevTier: 4 });
      gameEvents.emit('propDestroyed', { archetype: 'trashCan' });
      gameEvents.emit('civHit', {});
      gameEvents.emit('civWrecked', {});
      gameEvents.emit('unitWrecked', { unitKind: 'tank' });
      gameEvents.emit('playerDamaged', { hp: 90, amount: 10 });
      gameEvents.emit('transformerDestroyed', { districtId: 3 });
      gameEvents.emit('darkCity', {});
      gameEvents.emit('enteredWater', {});
      gameEvents.emit('playerWrecked', {});
      gameEvents.emit('busted', {});
      gameEvents.emit('runEnded', { score: 42, reason: 'wrecked' });
    }).not.toThrow();

    teardown();
  });

  it('the debug board\'s own "fire every registered sound" loop never throws, for any SoundName', () => {
    useGameStore.setState({ machine: 'PLAYING' });
    unlockAudioContext();
    registerAllEventSounds();

    for (const name of SOUND_NAMES) {
      expect(() => playEvent(name, { tier: 3, velocity: 0.5, variant: 1, seed: 1, speed: 0.5, throttle: 0.5 })).not.toThrow();
    }

    expect(getEventMapSnapshot().liveVoiceTotal).toBeGreaterThan(0);
  });
});
