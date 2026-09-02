import { and, count, eq, gte, like, lte } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { chains, grades, hotels, reservations, rooms } from './schema.ts';

export type Db = MySql2Database<Record<string, never>>;

export function findReservationsByRoom(db: Db, roomId: number) {
  return db.select().from(reservations).where(eq(reservations.roomId, roomId));
}

export function occupancyByHotel(db: Db, hotelId: number, startDate: string, endDate: string) {
  return db
    .select({ reservationId: reservations.id, roomId: rooms.id, startDate: reservations.startDate })
    .from(reservations)
    .innerJoin(rooms, eq(reservations.roomId, rooms.id))
    .where(and(eq(rooms.hotelId, hotelId), gte(reservations.startDate, startDate), lte(reservations.startDate, endDate)));
}

export function roomsByGrade(db: Db, grade: string) {
  return db.select().from(rooms).where(eq(rooms.grade, grade));
}

export function roomsByGradeWithLabel(db: Db, grade: string) {
  return db
    .select({ number: rooms.number, hotelId: rooms.hotelId, grade: grades.label })
    .from(rooms)
    .innerJoin(grades, eq(rooms.grade, grades.code))
    .where(eq(rooms.grade, grade));
}

export function roomCountsByGrade(db: Db) {
  return db
    .select({ grade: grades.label, total: count() })
    .from(rooms)
    .innerJoin(grades, eq(rooms.grade, grades.code))
    .groupBy(grades.label);
}

export function roomsForChain(db: Db, chainId: number) {
  return db
    .select({ roomId: rooms.id, roomNumber: rooms.number, hotelName: hotels.name })
    .from(chains)
    .innerJoin(hotels, eq(hotels.chainId, chains.id))
    .innerJoin(rooms, eq(rooms.hotelId, hotels.id))
    .where(eq(chains.id, chainId));
}

export function chainById(db: Db, chainId: number) {
  return db.select().from(chains).where(eq(chains.id, chainId));
}

export function reservationsByGuestName(db: Db, guestName: string) {
  return db.select().from(reservations).where(like(reservations.guestName, guestName));
}
