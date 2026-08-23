import { date, index, integer, pgTable, serial, text } from 'drizzle-orm/pg-core';

export const chains = pgTable('chains', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});

export const hotels = pgTable(
  'hotels',
  {
    id: serial('id').primaryKey(),
    chainId: integer('chain_id')
      .notNull()
      .references(() => chains.id),
    name: text('name').notNull(),
  },
  (table) => [index('hotels_chain_id_idx').on(table.chainId)],
);

export const rooms = pgTable(
  'rooms',
  {
    id: serial('id').primaryKey(),
    hotelId: integer('hotel_id')
      .notNull()
      .references(() => hotels.id),
    number: integer('number').notNull(),
    grade: text('grade').notNull(),
  },
  (table) => [index('rooms_hotel_id_idx').on(table.hotelId), index('rooms_grade_idx').on(table.grade)],
);

export const reservations = pgTable(
  'reservations',
  {
    id: serial('id').primaryKey(),
    roomId: integer('room_id')
      .notNull()
      .references(() => rooms.id),
    guestName: text('guest_name').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
  },
  (table) => [index('reservations_room_id_idx').on(table.roomId), index('reservations_start_date_idx').on(table.startDate)],
);
