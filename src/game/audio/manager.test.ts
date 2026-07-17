import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGameStore } from '../state/store';
import { AUDIO_BUSES } from '../config/audio';
import {
  acquireVoice,
  liveVoiceCount,
  busGains,
  registerSound,
  hasSound,
  playEvent,
  unlockAudioContext,
  closeAudioContext,
  getAudioContext,
  getAudioContextState,
  getBusNode,
  setAudioContextFactory,
  initAudioManager,
  resolveMuteTarget,
  resolveBusTargets,
  __resetAudioManagerForTest,
} from './manager';

// jsdom (this repo's unit-test DOM) has no Web Audio implementation at all — same constraint
// documented in audio/sirens.ts's file header. Rather than limiting this suite to pure
// helpers only, the module was explicitly designed for dependency injection
// (`setAudioContextFactory`): these fakes implement exactly the surface manager.ts touches
// (createGain/currentTime/destination/close/state on the context; gain/connect/disconnect on
// a node), which lets every non-pure code path — unlock, bus graph, voice routing, mute/pause
// gating — be exercised for real instead of only the pure decision functions.

class FakeAudioParam {
  value = 0;
  cancelScheduledValues = vi.fn(() => this);
  linearRampToValueAtTime = vi.fn((target: number) => {
    this.value = target; // no real audio clock in tests — treat a scheduled ramp as instant.
    return this;
  });
}

class FakeGainNode {
  gain = new FakeAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAudioContext {
  currentTime = 0;
  destination = {} as AudioDestinationNode;
  state: AudioContextState = 'running';
  createGain(): GainNode {
    return new FakeGainNode() as unknown as GainNode;
  }
  close = vi.fn(async () => {
    this.state = 'closed';
  });
}

let factoryCallCount = 0;
function fakeContextFactory(): AudioContext | null {
  factoryCallCount++;
  return new FakeAudioContext() as unknown as AudioContext;
}

function fakeNode(): AudioNode {
  return new FakeGainNode() as unknown as AudioNode;
}

const initialStoreState = useGameStore.getState();

beforeEach(() => {
  localStorage.clear();
  useGameStore.setState(initialStoreState, true);
  __resetAudioManagerForTest();
  factoryCallCount = 0;
});

// --- pure helpers ------------------------------------------------------------------------------

describe('resolveMuteTarget (pure)', () => {
  it('is 0 when muted', () => {
    expect(resolveMuteTarget(true)).toBe(0);
  });

  it('is cfg.masterGain when unmuted (defaults to exactly 1 — the literal "0/1" switch)', () => {
    expect(resolveMuteTarget(false)).toBe(AUDIO_BUSES.masterGain);
    expect(resolveMuteTarget(false, { masterGain: 1 })).toBe(1);
  });
});

describe('resolveBusTargets (pure)', () => {
  it('PLAYING: sfx/engine/ambient all at their configured gains', () => {
    expect(resolveBusTargets('PLAYING')).toEqual({
      sfx: AUDIO_BUSES.sfxGain,
      engine: AUDIO_BUSES.engineGain,
      ambient: AUDIO_BUSES.ambientGain,
    });
  });

  it('GARAGE: sfx/engine silent, ambient quiet (ambientGain * garageAmbientGain)', () => {
    expect(resolveBusTargets('GARAGE')).toEqual({
      sfx: 0,
      engine: 0,
      ambient: AUDIO_BUSES.ambientGain * AUDIO_BUSES.garageAmbientGain,
    });
  });

  it.each(['PAUSED', 'GAMEOVER', 'BOOT', 'LOADING'] as const)(
    '%s: sfx/engine/ambient all silent',
    (machine) => {
      expect(resolveBusTargets(machine)).toEqual({ sfx: 0, engine: 0, ambient: 0 });
    },
  );
});

// --- voice pool: caps + priority eviction -------------------------------------------------------

describe('acquireVoice: per-group caps', () => {
  it('impact caps at 6 (TDD §11 / phase-15-plan.md)', () => {
    for (let i = 0; i < 6; i++) expect(acquireVoice('impact', 1)).not.toBeNull();
    expect(liveVoiceCount('impact')).toBe(6);
    expect(acquireVoice('impact', 1)).toBeNull(); // 7th, same priority as the pool — refused
    expect(liveVoiceCount('impact')).toBe(6);
  });

  it('gun caps at 4', () => {
    for (let i = 0; i < 4; i++) expect(acquireVoice('gun', 1)).not.toBeNull();
    expect(acquireVoice('gun', 1)).toBeNull();
  });

  it('explosion caps at 3', () => {
    for (let i = 0; i < 3; i++) expect(acquireVoice('explosion', 1)).not.toBeNull();
    expect(acquireVoice('explosion', 1)).toBeNull();
  });

  it('loop is uncapped but tracked — every acquire succeeds, count keeps growing', () => {
    for (let i = 0; i < 50; i++) expect(acquireVoice('loop', 0)).not.toBeNull();
    expect(liveVoiceCount('loop')).toBe(50);
  });

  it('pools are independent per group — filling one does not affect another', () => {
    for (let i = 0; i < 6; i++) acquireVoice('impact', 1);
    expect(acquireVoice('gun', 1)).not.toBeNull();
    expect(liveVoiceCount('gun')).toBe(1);
  });
});

describe('acquireVoice: priority eviction', () => {
  it('a strictly higher-priority acquire on a full pool NEVER fails', () => {
    acquireVoice('explosion', 1);
    acquireVoice('explosion', 1);
    acquireVoice('explosion', 1);
    expect(liveVoiceCount('explosion')).toBe(3);

    const high = acquireVoice('explosion', 5);
    expect(high).not.toBeNull();
    expect(liveVoiceCount('explosion')).toBe(3); // one evicted, one added — still at cap
  });

  it('evicts the LOWEST-priority voice, not just any voice', () => {
    const low = acquireVoice('gun', 1)!;
    const mid1 = acquireVoice('gun', 3)!;
    const mid2 = acquireVoice('gun', 3)!;
    acquireVoice('gun', 2);
    expect(liveVoiceCount('gun')).toBe(4); // at cap

    acquireVoice('gun', 10);

    expect(low.isLive).toBe(false);
    expect(mid1.isLive).toBe(true);
    expect(mid2.isLive).toBe(true);
  });

  it('among equal-lowest-priority voices, evicts the OLDEST (first acquired)', () => {
    const first = acquireVoice('gun', 1)!;
    const second = acquireVoice('gun', 1)!;
    acquireVoice('gun', 1);
    acquireVoice('gun', 1);
    expect(liveVoiceCount('gun')).toBe(4);

    acquireVoice('gun', 9);

    expect(first.isLive).toBe(false);
    expect(second.isLive).toBe(true);
  });

  it('an equal-priority acquire on a full pool is refused, not evicted', () => {
    const a = acquireVoice('gun', 5)!;
    acquireVoice('gun', 5);
    acquireVoice('gun', 5);
    acquireVoice('gun', 5);
    expect(acquireVoice('gun', 5)).toBeNull();
    expect(a.isLive).toBe(true); // nothing was evicted
    expect(liveVoiceCount('gun')).toBe(4);
  });

  it('a lower-priority acquire on a full pool is refused, not evicted', () => {
    acquireVoice('gun', 5);
    acquireVoice('gun', 5);
    acquireVoice('gun', 5);
    acquireVoice('gun', 5);
    expect(acquireVoice('gun', 1)).toBeNull();
    expect(liveVoiceCount('gun')).toBe(4);
  });

  it('calls the evicted voice\'s onEvicted callback exactly once', () => {
    const onEvicted = vi.fn();
    const victim = acquireVoice('explosion', 1, onEvicted)!; // oldest of the priority-1 voices
    acquireVoice('explosion', 1);
    acquireVoice('explosion', 1);
    expect(liveVoiceCount('explosion')).toBe(3);

    acquireVoice('explosion', 9); // evicts victim specifically (lowest priority, oldest)

    expect(victim.isLive).toBe(false);
    expect(onEvicted).toHaveBeenCalledTimes(1);
  });

  it('an evicted voice is disconnected from its bus immediately', () => {
    setAudioContextFactory(fakeContextFactory);
    unlockAudioContext();
    const victim = acquireVoice('gun', 1)!;
    const node = fakeNode();
    victim.connect(node, 'sfx');
    acquireVoice('gun', 1);
    acquireVoice('gun', 1);
    acquireVoice('gun', 1);
    expect(liveVoiceCount('gun')).toBe(4);

    acquireVoice('gun', 9); // evicts victim (lowest priority, oldest)

    expect(victim.isLive).toBe(false);
    expect((node as unknown as FakeGainNode).disconnect).toHaveBeenCalled();
  });
});

// --- release bookkeeping -------------------------------------------------------------------------

describe('VoiceHandle.release', () => {
  it('frees the pool slot and flips isLive to false', () => {
    const v = acquireVoice('ui', 1)!;
    expect(liveVoiceCount('ui')).toBe(1);
    v.release();
    expect(v.isLive).toBe(false);
    expect(liveVoiceCount('ui')).toBe(0);
  });

  it('is idempotent — calling it twice does not double-decrement', () => {
    const v = acquireVoice('ui', 1)!;
    v.release();
    v.release();
    expect(liveVoiceCount('ui')).toBe(0);
  });

  it('is a harmless no-op when called on an already-evicted handle', () => {
    const victim = acquireVoice('stinger', 1)!;
    acquireVoice('stinger', 1);
    expect(liveVoiceCount('stinger')).toBe(2); // stinger cap is 2

    acquireVoice('stinger', 9); // evicts victim
    expect(victim.isLive).toBe(false);
    expect(liveVoiceCount('stinger')).toBe(2);

    expect(() => victim.release()).not.toThrow();
    expect(liveVoiceCount('stinger')).toBe(2); // no further change — victim was already gone
  });

  it('a released slot can be reacquired', () => {
    const v = acquireVoice('stinger', 1)!;
    v.release();
    expect(acquireVoice('stinger', 1)).not.toBeNull();
    expect(liveVoiceCount('stinger')).toBe(1);
  });
});

// --- registration / dispatch seam -----------------------------------------------------------------

describe('registerSound / playEvent', () => {
  it('hasSound reflects registration state', () => {
    expect(hasSound('test:coverage')).toBe(false);
    registerSound('test:coverage', vi.fn());
    expect(hasSound('test:coverage')).toBe(true);
  });

  it('dispatches the registered builder with params and a PlayCtx exposing ctx/now/acquireVoice', () => {
    setAudioContextFactory(fakeContextFactory);
    const builder = vi.fn();
    registerSound('test:tick', builder);

    playEvent('test:tick', { pitch: 2 });

    expect(builder).toHaveBeenCalledTimes(1);
    const [playCtx, params] = builder.mock.calls[0];
    expect(params).toEqual({ pitch: 2 });
    expect(playCtx.ctx).toBe(getAudioContext());
    expect(typeof playCtx.now).toBe('number');
    expect(playCtx.acquireVoice).toBe(acquireVoice);
  });

  it('an unregistered event name is a silent no-op — never throws', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => playEvent('does-not-exist')).not.toThrow();
    warnSpy.mockRestore();
  });

  it('lazily unlocks the shared context on first dispatch if nothing has unlocked it yet', () => {
    setAudioContextFactory(fakeContextFactory);
    expect(getAudioContext()).toBeNull();
    registerSound('test:lazy-unlock', vi.fn());

    playEvent('test:lazy-unlock');

    expect(getAudioContext()).not.toBeNull();
  });

  it('is a no-op (no throw) if Web Audio is unavailable', () => {
    setAudioContextFactory(() => null);
    const builder = vi.fn();
    registerSound('test:unsupported', builder);

    expect(() => playEvent('test:unsupported')).not.toThrow();
    expect(builder).not.toHaveBeenCalled();
  });
});

// --- context / bus graph ---------------------------------------------------------------------------

describe('unlockAudioContext', () => {
  it('is idempotent — the injected factory only runs once across repeated calls', () => {
    setAudioContextFactory(fakeContextFactory);
    const a = unlockAudioContext();
    const b = unlockAudioContext();
    expect(a).toBe(b);
    expect(factoryCallCount).toBe(1);
  });

  it('returns null and never throws when Web Audio is unsupported', () => {
    setAudioContextFactory(() => null);
    expect(unlockAudioContext()).toBeNull();
    expect(getAudioContext()).toBeNull();
    expect(getAudioContextState()).toBeNull();
  });

  it('creates all three bus GainNodes', () => {
    expect(getBusNode('sfx')).toBeNull();
    expect(getBusNode('engine')).toBeNull();
    expect(getBusNode('ambient')).toBeNull();

    setAudioContextFactory(fakeContextFactory);
    unlockAudioContext();

    expect(getBusNode('sfx')).not.toBeNull();
    expect(getBusNode('engine')).not.toBeNull();
    expect(getBusNode('ambient')).not.toBeNull();
  });
});

describe('busGains / liveVoiceCount introspection', () => {
  it('busGains() reads all zero before unlock', () => {
    expect(busGains()).toEqual({ master: 0, sfx: 0, engine: 0, ambient: 0 });
  });

  it('busGains() reflects the resolved targets for the machine state at unlock time', () => {
    useGameStore.setState({ machine: 'PLAYING' });
    setAudioContextFactory(fakeContextFactory);
    unlockAudioContext();

    expect(busGains()).toEqual({
      master: AUDIO_BUSES.masterGain,
      sfx: AUDIO_BUSES.sfxGain,
      engine: AUDIO_BUSES.engineGain,
      ambient: AUDIO_BUSES.ambientGain,
    });
  });

  it('liveVoiceCount() with no group sums every group', () => {
    acquireVoice('impact', 1);
    acquireVoice('impact', 1);
    acquireVoice('gun', 1);
    expect(liveVoiceCount()).toBe(3);
  });

  it('closeAudioContext resets everything to the pre-unlock state', () => {
    setAudioContextFactory(fakeContextFactory);
    unlockAudioContext();
    expect(getAudioContext()).not.toBeNull();

    closeAudioContext();

    expect(getAudioContext()).toBeNull();
    expect(getAudioContextState()).toBeNull();
    expect(getBusNode('sfx')).toBeNull();
    expect(busGains()).toEqual({ master: 0, sfx: 0, engine: 0, ambient: 0 });
  });
});

// --- VoiceHandle.connect ------------------------------------------------------------------------

describe('VoiceHandle.connect', () => {
  it('is a no-op before the context/bus graph exists', () => {
    const v = acquireVoice('impact', 1)!;
    const node = fakeNode();
    expect(() => v.connect(node)).not.toThrow();
    expect((node as unknown as FakeGainNode).connect).not.toHaveBeenCalled();
  });

  it('connects into the requested bus once unlocked', () => {
    setAudioContextFactory(fakeContextFactory);
    unlockAudioContext();
    const v = acquireVoice('impact', 1)!;
    const node = fakeNode();

    v.connect(node, 'engine');

    expect((node as unknown as FakeGainNode).connect).toHaveBeenCalledWith(getBusNode('engine'));
  });

  it('defaults to the sfx bus when no bus is given', () => {
    setAudioContextFactory(fakeContextFactory);
    unlockAudioContext();
    const v = acquireVoice('ui', 1)!;
    const node = fakeNode();

    v.connect(node);

    expect((node as unknown as FakeGainNode).connect).toHaveBeenCalledWith(getBusNode('sfx'));
  });

  it('is a no-op once the voice has been released', () => {
    setAudioContextFactory(fakeContextFactory);
    unlockAudioContext();
    const v = acquireVoice('impact', 1)!;
    v.release();
    const node = fakeNode();

    v.connect(node);

    expect((node as unknown as FakeGainNode).connect).not.toHaveBeenCalled();
  });
});

// --- initAudioManager: mute + machine-state bus gating --------------------------------------------

describe('initAudioManager', () => {
  let teardown: (() => void) | null = null;

  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  it('unlocks the shared context on the first PLAYING entry', () => {
    setAudioContextFactory(fakeContextFactory);
    teardown = initAudioManager();
    expect(getAudioContext()).toBeNull();

    useGameStore.setState({ machine: 'PLAYING' });

    expect(getAudioContext()).not.toBeNull();
    expect(getAudioContextState()).toBe('running');
  });

  it('mute ramps master gain to 0; unmute restores it', () => {
    setAudioContextFactory(fakeContextFactory);
    useGameStore.setState({ machine: 'PLAYING' });
    teardown = initAudioManager();
    expect(busGains().master).toBe(AUDIO_BUSES.masterGain);

    useGameStore.getState().toggleMuted();
    expect(busGains().master).toBe(0);

    useGameStore.getState().toggleMuted();
    expect(busGains().master).toBe(AUDIO_BUSES.masterGain);
  });

  it('PAUSED silences sfx, engine, and ambient', () => {
    setAudioContextFactory(fakeContextFactory);
    useGameStore.setState({ machine: 'PLAYING' });
    teardown = initAudioManager();
    expect(busGains().sfx).toBe(AUDIO_BUSES.sfxGain);

    useGameStore.setState({ machine: 'PAUSED' });

    expect(busGains()).toEqual({
      master: AUDIO_BUSES.masterGain,
      sfx: 0,
      engine: 0,
      ambient: 0,
    });
  });

  it('GAMEOVER silences sfx, engine, and ambient', () => {
    setAudioContextFactory(fakeContextFactory);
    useGameStore.setState({ machine: 'PLAYING' });
    teardown = initAudioManager();

    useGameStore.setState({ machine: 'GAMEOVER' });

    expect(busGains().sfx).toBe(0);
    expect(busGains().engine).toBe(0);
    expect(busGains().ambient).toBe(0);
  });

  it('GARAGE silences sfx/engine but allows a quiet ambient bed', () => {
    setAudioContextFactory(fakeContextFactory);
    teardown = initAudioManager();
    useGameStore.setState({ machine: 'PLAYING' }); // unlocks the context
    useGameStore.setState({ machine: 'GARAGE' });

    const gains = busGains();
    expect(gains.sfx).toBe(0);
    expect(gains.engine).toBe(0);
    expect(gains.ambient).toBeCloseTo(AUDIO_BUSES.ambientGain * AUDIO_BUSES.garageAmbientGain);
  });

  it('resuming from PAUSED back to PLAYING restores sfx/engine without double-unlocking', () => {
    setAudioContextFactory(fakeContextFactory);
    useGameStore.setState({ machine: 'PLAYING' });
    teardown = initAudioManager();
    const ctxAfterFirstUnlock = getAudioContext();

    useGameStore.setState({ machine: 'PAUSED' });
    useGameStore.setState({ machine: 'PLAYING' });

    expect(getAudioContext()).toBe(ctxAfterFirstUnlock); // same context — never recreated
    expect(factoryCallCount).toBe(1);
    expect(busGains().sfx).toBe(AUDIO_BUSES.sfxGain);
  });

  it('its own teardown fully closes the shared context', () => {
    setAudioContextFactory(fakeContextFactory);
    useGameStore.setState({ machine: 'PLAYING' });
    teardown = initAudioManager();
    expect(getAudioContext()).not.toBeNull();

    teardown();
    teardown = null;

    expect(getAudioContext()).toBeNull();
    expect(busGains()).toEqual({ master: 0, sfx: 0, engine: 0, ambient: 0 });
  });
});
