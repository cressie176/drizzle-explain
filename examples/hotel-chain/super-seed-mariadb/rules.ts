import { derive, randomWords, structuralDefault, weightedPick } from 'drizzle-super-seed';
import type { SchemaRules, TableRules, ValueGenerator } from 'drizzle-super-seed';
import * as schema from './schema.ts';

const DAY_MS = 86_400_000;

// The same bimodal fan-out the drizzle-seed package expresses with weighted
// count ranges: most parents get a modest number of children, a minority get
// many. Custom generators are plain functions of the seeded random source.
export function bimodalCount(commonWeight: number, common: [number, number], rare: [number, number]): ValueGenerator<number> {
  return (context) => {
    const [min, max] = context.random.chance(commonWeight) ? common : rare;
    return context.random.intBetween(min, max);
  };
}

// Concentrate stays in summer so date-range selectivity varies by month.
// A drizzle date() column in string mode inserts a string, so the generator
// produces one.
function summerDate(): ValueGenerator<string> {
  return (context) => {
    const first = Date.UTC(2025, 4, 1);
    const last = Date.UTC(2025, 8, 30);
    const day = context.random.intBetween(0, (last - first) / DAY_MS);
    return isoDate(first + day * DAY_MS);
  };
}

function isoDate(epochMs: number) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function roomNumber(): ValueGenerator<string> {
  return (context) => String(context.random.intBetween(1, 500));
}

const chainRules = {
  id: structuralDefault,
  name: randomWords({ minLength: 8, maxLength: 20 }),
} satisfies TableRules<typeof schema.chains>;

const hotelRules = {
  id: structuralDefault,
  chainId: structuralDefault,
  name: randomWords({ minLength: 8, maxLength: 24 }),
} satisfies TableRules<typeof schema.hotels>;

const roomRules = {
  id: structuralDefault,
  hotelId: structuralDefault,
  number: roomNumber(),
  // Grade skew gives the grade index a realistic distribution.
  grade: weightedPick({ standard: 0.5, superior: 0.3, deluxe: 0.15, suite: 0.03, penthouse: 0.02 }),
} satisfies TableRules<typeof schema.rooms>;

const reservationRules = {
  id: structuralDefault,
  roomId: structuralDefault,
  guestName: randomWords({ minLength: 8, maxLength: 24 }),
  startDate: summerDate(),
  endDate: derive((reservation, context) => isoDate(Date.parse(reservation.startDate as string) + context.random.intBetween(1, 14) * DAY_MS)),
} satisfies TableRules<typeof schema.reservations>;

// grades is reference data, inserted by the DDL rather than generated, so the
// generated schema names the four tables super-seed is responsible for.
export const generated = {
  chains: schema.chains,
  hotels: schema.hotels,
  rooms: schema.rooms,
  reservations: schema.reservations,
};

export const rules = {
  chains: chainRules,
  hotels: hotelRules,
  rooms: roomRules,
  reservations: reservationRules,
} satisfies SchemaRules<typeof generated>;

export const counts = {
  chains: 5,
  hotels: { per: 'chains', count: bimodalCount(0.7, [10, 20], [30, 50]) },
  rooms: { per: 'hotels', count: bimodalCount(0.6, [80, 120], [200, 400]) },
  reservations: { per: 'rooms', count: bimodalCount(0.8, [20, 60], [80, 150]) },
};
