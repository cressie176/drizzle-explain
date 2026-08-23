import { relations } from 'drizzle-orm';
import { date, index, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

export const chains = mysqlTable('chains', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 128 }).notNull(),
});

export const hotels = mysqlTable(
  'hotels',
  {
    id: int('id').primaryKey().autoincrement(),
    chainId: int('chain_id')
      .notNull()
      .references(() => chains.id),
    name: varchar('name', { length: 128 }).notNull(),
  },
  (table) => ({
    chainIdIdx: index('hotels_chain_id_idx').on(table.chainId),
  }),
);

export const rooms = mysqlTable(
  'rooms',
  {
    id: int('id').primaryKey().autoincrement(),
    hotelId: int('hotel_id')
      .notNull()
      .references(() => hotels.id),
    number: varchar('number', { length: 16 }).notNull(),
    grade: varchar('grade', { length: 16 }).notNull(),
  },
  (table) => ({
    hotelIdIdx: index('rooms_hotel_id_idx').on(table.hotelId),
    gradeIdx: index('rooms_grade_idx').on(table.grade),
  }),
);

export const reservations = mysqlTable(
  'reservations',
  {
    id: int('id').primaryKey().autoincrement(),
    roomId: int('room_id')
      .notNull()
      .references(() => rooms.id),
    guestName: varchar('guest_name', { length: 128 }).notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
  },
  (table) => ({
    roomIdIdx: index('reservations_room_id_idx').on(table.roomId),
    startDateIdx: index('reservations_start_date_idx').on(table.startDate),
  }),
);

export const chainsRelations = relations(chains, ({ many }) => ({
  hotels: many(hotels),
}));

export const hotelsRelations = relations(hotels, ({ one, many }) => ({
  chain: one(chains, { fields: [hotels.chainId], references: [chains.id] }),
  rooms: many(rooms),
}));

export const roomsRelations = relations(rooms, ({ one, many }) => ({
  hotel: one(hotels, { fields: [rooms.hotelId], references: [hotels.id] }),
  reservations: many(reservations),
}));

export const reservationsRelations = relations(reservations, ({ one }) => ({
  room: one(rooms, { fields: [reservations.roomId], references: [rooms.id] }),
}));
