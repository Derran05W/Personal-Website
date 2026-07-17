// Garage screen content (Phase 17 Task 4). Rendered by ../../GarageOverlay.tsx, which
// stays the thin file game/index.tsx actually imports (untouched by this task) — all the
// real UI lives here per the task brief's "hud/garage/ + replace GarageOverlay.tsx" split.
//
// Six car cards (name, character line, speed/accel/handling stat bars with A-D letter
// badges, hp + mass as numbers, lock state with a threshold/progress readout, selected
// highlight, a session-scoped "NEW" pulse) plus a "New city" seed reroll and a "Start
// driving" button. Real <button> elements throughout (not roving tabindex) — every card,
// plus New city/Start, sits in the natural Tab order; arrow keys additionally hop between
// cards for a faster keyboard flow. Visual language matches hud/Hud.css /
// hud/GameOver.tsx: dark translucent chips, amber accents, the display font for anything
// that should read as "the one chunky element" on the card.
import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { getGameState, useGameStore } from '../../state/store';
import { canTransition } from '../../state/machine';
import { loadProgress, recordLastSeed } from '../../state/persistence';
import { PLAYER_CARS, VEHICLE_TUNING, type PlayerCarId, type StatGrade } from '../../config/vehicles';
import { UNLOCKS } from '../../config/unlocks';
import { GARAGE_GRID_COLUMNS, gradeBarPercent, nextGridIndex, unlockProgressPct } from './garageFormat';
import { clearNewBadge, isNewBadge } from './newBadge';
import './Garage.css';

// PLAYER_CARS' declared key order (Object.keys preserves string-key insertion order) —
// the same order the TDD §5.9 table and config/unlocks.ts's UNLOCKS use.
const CAR_IDS = Object.keys(PLAYER_CARS) as PlayerCarId[];

function handleStart(): void {
  const state = getGameState();
  if (canTransition(state.machine, 'PLAYING')) state.transition('PLAYING');
}

/** Rerolls the seed for a brand-new city. `Date.now()` is an accepted source of
 * randomish-ness in app code (task brief) — this isn't a gameplay-fairness RNG, just a
 * fresh WORLD_GEN seed. Records the choice immediately (not only on `runStarted`) so it
 * survives even if the player never actually presses Start this session. */
function handleNewCity(): void {
  const newSeed = Math.floor(Date.now() % 1_000_000);
  getGameState().setSeed(newSeed);
  recordLastSeed(newSeed);
}

const overlayStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '1.5rem',
  overflowY: 'auto',
};

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '1rem',
  width: '100%',
  maxWidth: '64rem',
  margin: 'auto',
};

const titleStyle: CSSProperties = {
  display: 'block',
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 'clamp(1.75rem, 5vw, 2.5rem)',
  letterSpacing: '0.02em',
  color: '#f5f5f5',
  textShadow: '0 2px 20px rgba(0, 0, 0, 0.6)',
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: `repeat(${GARAGE_GRID_COLUMNS}, minmax(0, 1fr))`,
  gap: '0.85rem',
  width: '100%',
};

const actionsStyle: CSSProperties = {
  display: 'flex',
  gap: '0.75rem',
  flexWrap: 'wrap',
  justifyContent: 'center',
};

const hintStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.85rem',
  color: 'rgba(245, 245, 245, 0.7)',
  textAlign: 'center',
};

function StatBar({ label, grade }: { label: string; grade: StatGrade }) {
  const pct = gradeBarPercent(grade);
  return (
    <div className="garage-stat">
      <span className="garage-stat__label">{label}</span>
      <span className="garage-stat__track">
        <span className="garage-stat__fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="garage-stat__badge">{grade}</span>
    </div>
  );
}

interface CarCardProps {
  carId: PlayerCarId;
  index: number;
  selected: boolean;
  unlocked: boolean;
  lifetimeScore: number;
  setRef: (el: HTMLButtonElement | null) => void;
  onFocusMove: (nextIndex: number) => void;
}

function CarCard({ carId, index, selected, unlocked, lifetimeScore, setRef, onFocusMove }: CarCardProps) {
  const car = PLAYER_CARS[carId];
  const threshold = UNLOCKS[carId];
  const massKg = Math.round(VEHICLE_TUNING.chassis.massKg * car.massFactor);
  // Local state, seeded once from the module-scope "unlocked this session" set (Phase 17
  // task brief: "persist nothing extra for the badge — module state ok"), so a click can
  // clear the pulse IMMEDIATELY within the same open garage session without depending on
  // a parent re-render. `unlocked &&` guards a locked card from ever showing NEW (an id
  // can only land in the module set via a real carUnlocked, which by definition means
  // it's already unlocked, but this is cheap belt-and-suspenders against ordering bugs).
  const [showNew, setShowNew] = useState(() => unlocked && isNewBadge(carId));

  function handleClick(): void {
    if (!unlocked) return;
    clearNewBadge(carId);
    setShowNew(false);
    getGameState().selectCar(carId);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    const next = nextGridIndex(index, event.key, CAR_IDS.length, GARAGE_GRID_COLUMNS);
    if (next !== index) {
      event.preventDefault();
      onFocusMove(next);
    }
  }

  const classes = [
    'garage-card',
    selected ? 'garage-card--selected' : '',
    unlocked ? '' : 'garage-card--locked',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      ref={setRef}
      className={classes}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-pressed={selected}
      aria-disabled={!unlocked}
      data-testid={`garage-card-${carId}`}
    >
      {showNew ? (
        <span className="garage-card__new" data-testid={`garage-new-${carId}`} aria-hidden="true">
          NEW
        </span>
      ) : null}
      <span className="garage-card__name">{car.name}</span>
      <span className="garage-card__character">{car.character}</span>
      <div className="garage-card__stats">
        <StatBar label="Speed" grade={car.speed} />
        <StatBar label="Accel" grade={car.accel} />
        <StatBar label="Handling" grade={car.handling} />
      </div>
      <div className="garage-card__numbers">
        <span>{car.hp} HP</span>
        <span>{massKg.toLocaleString('en-US')} kg</span>
      </div>
      {unlocked ? null : (
        <div className="garage-card__lock" data-testid={`garage-lock-${carId}`}>
          <span className="garage-card__lock-label">Locked — {threshold.toLocaleString('en-US')} pts</span>
          <span className="garage-card__lock-track">
            <span
              className="garage-card__lock-fill"
              style={{ width: `${unlockProgressPct(lifetimeScore, threshold)}%` }}
            />
          </span>
          <span className="garage-card__lock-current">
            {Math.min(lifetimeScore, threshold).toLocaleString('en-US')} /{' '}
            {threshold.toLocaleString('en-US')}
          </span>
        </div>
      )}
    </button>
  );
}

export function Garage() {
  const selectedCarId = useGameStore((s) => s.selectedCarId);
  const unlockedCarIds = useGameStore((s) => s.unlockedCarIds);
  const seed = useGameStore((s) => s.seed);
  // Meta-progression, not per-frame hot data — a plain synchronous localStorage read on
  // every render is fine (the garage is unreachable during PLAYING, so this never competes
  // with the physics loop, and re-renders here only happen on discrete user actions, not
  // every frame). lifetimeScore can't actually change while the garage is open in
  // practice (it only moves on a run's runEnded fold, and GARAGE is not reachable from
  // PLAYING without going through GAMEOVER first) — no memoization needed.
  const lifetimeScore = loadProgress().lifetimeScore;
  const cardRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function focusCard(index: number): void {
    cardRefs.current[index]?.focus();
  }

  return (
    <div className="garage-overlay" style={overlayStyle} data-testid="garage-root">
      <div style={panelStyle}>
        <span style={titleStyle}>Choose your ride</span>
        <div style={gridStyle} data-testid="garage-grid">
          {CAR_IDS.map((carId, index) => (
            <CarCard
              key={carId}
              carId={carId}
              index={index}
              selected={carId === selectedCarId}
              unlocked={unlockedCarIds.includes(carId)}
              lifetimeScore={lifetimeScore}
              setRef={(el) => {
                cardRefs.current[index] = el;
              }}
              onFocusMove={focusCard}
            />
          ))}
        </div>
        <div style={actionsStyle}>
          <button
            type="button"
            className="garage-btn garage-btn--ghost"
            onClick={handleNewCity}
            data-testid="garage-new-city"
          >
            New city
          </button>
          <button
            type="button"
            className="garage-btn garage-btn--primary"
            onClick={handleStart}
            autoFocus
            data-testid="garage-start"
          >
            Start driving
          </button>
        </div>
        <span style={hintStyle}>Arrows move · Enter select · seed {seed}</span>
      </div>
    </div>
  );
}
