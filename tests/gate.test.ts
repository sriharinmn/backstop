import { describe, expect, it } from 'vitest';
import {
  cashAvailable,
  checkPayout,
  checkRefund,
  orderRefunds,
  requestId,
  type GateDispute,
  type GateTicket,
  type GateVendor,
} from '@/lib/gate';

const ticket = (over: Partial<GateTicket> = {}): GateTicket => ({
  id: 't1',
  amountCents: 3500,
  captureId: 'CAP1',
  status: 'refund_requested',
  requestedAt: '2026-11-14T06:10:00Z',
  ...over,
});

const noDisputes: GateDispute[] = [];

describe('checkRefund', () => {
  it('allows a captured ticket with a refund request', () => {
    expect(checkRefund(ticket(), noDisputes)).toEqual({ ok: true, amountCents: 3500 });
  });

  it('blocks a ticket with no capture', () => {
    const result = checkRefund(ticket({ captureId: null }), noDisputes);
    expect(result).toMatchObject({ ok: false, code: 'NO_CAPTURE' });
  });

  it('blocks a ticket that was already refunded', () => {
    const result = checkRefund(ticket({ status: 'refunded' }), noDisputes);
    expect(result).toMatchObject({ ok: false, code: 'ALREADY_REFUNDED' });
  });

  it('blocks a ticket the attendee moved to the new date', () => {
    const result = checkRefund(ticket({ status: 'transferred' }), noDisputes);
    expect(result).toMatchObject({ ok: false, code: 'TRANSFERRED' });
  });

  it('blocks a refund while a dispute is open, so the organizer never pays twice', () => {
    const open: GateDispute[] = [{ ticketId: 't1', status: 'WAITING_FOR_SELLER_RESPONSE' }];
    const result = checkRefund(ticket(), open);
    expect(result).toMatchObject({ ok: false, code: 'OPEN_DISPUTE' });
  });

  it('ignores a resolved dispute and disputes on other tickets', () => {
    const disputes: GateDispute[] = [
      { ticketId: 't1', status: 'RESOLVED' },
      { ticketId: 't2', status: 'OPEN' },
    ];
    expect(checkRefund(ticket(), disputes)).toMatchObject({ ok: true });
  });

  it('never refunds more than was captured', () => {
    const result = checkRefund(ticket(), noDisputes, 3501);
    expect(result).toMatchObject({ ok: false, code: 'OVER_CAPTURE' });
  });

  it('allows a partial refund', () => {
    expect(checkRefund(ticket(), noDisputes, 1000)).toEqual({ ok: true, amountCents: 1000 });
  });

  it('rejects a zero or negative amount', () => {
    expect(checkRefund(ticket(), noDisputes, 0)).toMatchObject({ ok: false, code: 'BAD_AMOUNT' });
    expect(checkRefund(ticket(), noDisputes, -5)).toMatchObject({ ok: false, code: 'BAD_AMOUNT' });
  });
});

describe('checkPayout', () => {
  const vendor = (over: Partial<GateVendor> = {}): GateVendor => ({
    id: 'v1',
    owedCents: 40000,
    status: 'owed',
    ...over,
  });

  it('allows a vendor who is owed money', () => {
    expect(checkPayout(vendor())).toEqual({ ok: true, amountCents: 40000 });
  });

  it('blocks a vendor who was already paid', () => {
    expect(checkPayout(vendor({ status: 'paid' }))).toMatchObject({ ok: false, code: 'ALREADY_PAID' });
  });

  it('blocks a vendor who is owed nothing', () => {
    expect(checkPayout(vendor({ owedCents: 0 }))).toMatchObject({ ok: false, code: 'NOTHING_OWED' });
  });
});

describe('cashAvailable', () => {
  it('subtracts committed money from the balance', () => {
    expect(cashAvailable(100000, 30000)).toBe(70000);
  });

  it('never goes below zero', () => {
    expect(cashAvailable(1000, 5000)).toBe(0);
  });
});

describe('orderRefunds', () => {
  it('pays the earliest requests first', () => {
    const late = ticket({ id: 'late', requestedAt: '2026-11-14T08:00:00Z' });
    const early = ticket({ id: 'early', requestedAt: '2026-11-14T06:00:00Z' });

    const { paid } = orderRefunds([late, early], 10000);

    expect(paid.map((t) => t.id)).toEqual(['early', 'late']);
  });

  it('breaks ties on request time by the smaller amount', () => {
    const big = ticket({ id: 'big', amountCents: 9000 });
    const small = ticket({ id: 'small', amountCents: 1000 });

    const { paid } = orderRefunds([big, small], 10000);

    expect(paid.map((t) => t.id)).toEqual(['small', 'big']);
  });

  it('holds back what cash cannot cover and says why', () => {
    const a = ticket({ id: 'a', amountCents: 6000, requestedAt: '2026-11-14T06:00:00Z' });
    const b = ticket({ id: 'b', amountCents: 6000, requestedAt: '2026-11-14T06:05:00Z' });

    const { paid, held, shortfallCents } = orderRefunds([a, b], 7000);

    expect(paid.map((t) => t.id)).toEqual(['a']);
    expect(held.map((t) => t.id)).toEqual(['b']);
    expect(shortfallCents).toBe(5000);
  });

  it('keeps going past a ticket it cannot afford to pay a smaller later one', () => {
    const big = ticket({ id: 'big', amountCents: 9000, requestedAt: '2026-11-14T06:00:00Z' });
    const small = ticket({ id: 'small', amountCents: 1000, requestedAt: '2026-11-14T06:05:00Z' });

    const { paid, held } = orderRefunds([big, small], 2000);

    expect(paid.map((t) => t.id)).toEqual(['small']);
    expect(held.map((t) => t.id)).toEqual(['big']);
  });

  it('handles an empty list', () => {
    expect(orderRefunds([], 5000)).toEqual({ paid: [], held: [], shortfallCents: 0 });
  });
});

describe('requestId', () => {
  it('is the same for the same proposal and target, so a retry cannot pay twice', () => {
    expect(requestId('p1', 't1')).toBe(requestId('p1', 't1'));
  });

  it('differs across targets and proposals', () => {
    expect(requestId('p1', 't1')).not.toBe(requestId('p1', 't2'));
    expect(requestId('p1', 't1')).not.toBe(requestId('p2', 't1'));
  });

  it('stays within PayPal\'s 38 character limit', () => {
    expect(requestId('a'.repeat(100), 'b'.repeat(100)).length).toBeLessThanOrEqual(38);
  });
});
