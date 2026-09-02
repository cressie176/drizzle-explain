import { and, between, count, eq, like } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { chains, grades, hotels, reservations, rooms } from './schema.ts';

export type Db = PgDatabase<any, any>;

export function findReservationsByRoom(db: Db, roomId: number) {
  return db.select().from(reservations).where(eq(reservations.roomId, roomId));
}

export function occupancyByHotel(db: Db, hotelId: number, startDate: string, endDate: string) {
  return db
    .select({ id: reservations.id, roomId: reservations.roomId, startDate: reservations.startDate })
    .from(reservations)
    .innerJoin(rooms, eq(reservations.roomId, rooms.id))
    .where(and(eq(rooms.hotelId, hotelId), between(reservations.startDate, startDate, endDate)));
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

export function reservationsForChain(db: Db, chainId: number) {
  return db
    .select({ chain: chains.name, hotel: hotels.name, room: rooms.number, guest: reservations.guestName })
    .from(reservations)
    .innerJoin(rooms, eq(reservations.roomId, rooms.id))
    .innerJoin(hotels, eq(rooms.hotelId, hotels.id))
    .innerJoin(chains, eq(hotels.chainId, chains.id))
    .where(eq(chains.id, chainId));
}

export function findReservationsByGuest(db: Db, namePattern: string) {
  return db
    .select()
    .from(reservations)
    .where(like(reservations.guestName, namePattern));
}
