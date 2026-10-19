/**
 * The Team page's checks before a payment or a delete (Kian's rulings K1, K2 and K3 of 2026-10-19, in CLAUDE.md under
 * *Team page*), from a member's pay as the one function works it out (balance.ts). Pure and client-safe: the pay view
 * asks these questions before sending, the page refuses a delete at no read, and the server refuses it again inside
 * the delete's transaction with the same words.
 *
 * - K1: recording a payment while the person has cleanings with no amount, or receipts or work waiting for review,
 *   asks first; the question names the counts and says the balance does not include them. Still allowed.
 * - K2: a payment larger than the current balance asks first: "This pays $X more than <name> is owed. Record it as an
 *   advance?" Still allowed.
 * - K3: deleting a member is refused while they have any cleaning with no amount, or any receipt or work not yet
 *   decided, as well as with a balance that is not zero (Kian's ruling of 2026-10-15). The refusal names what is
 *   outstanding and points to Deactivate.
 */

import { formatCents } from '@/app/lib/cleaners/model';
import { balanceWords, type MemberPay } from './balance';

/** A question in the shape Nubnb's dialog asks (AskDialog's Question). */
export interface PayQuestion {
  title: string;
  lines: string[];
  confirm: string;
}

/** What the pay checks need of a member's pay. */
export type PayStanding = Pick<MemberPay, 'balanceCents' | 'noAmount' | 'waitingReview' | 'cannotAddUp'>;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 cleanings have no amount yet", "1 receipt or work entry is waiting for review": the parts of what is not counted, in order. */
export function notCountedWords(pay: Pick<PayStanding, 'noAmount' | 'waitingReview'>): string[] {
  const parts: string[] = [];
  if (pay.noAmount > 0) parts.push(`${plural(pay.noAmount, 'cleaning has', 'cleanings have')} no amount yet`);
  if (pay.waitingReview > 0) parts.push(`${plural(pay.waitingReview, 'receipt or work entry is', 'receipts or work entries are')} waiting for review`);
  return parts;
}

/**
 * The questions asked, in order, before a payment of `amountCents` to `name` is recorded: K1 while anything of theirs
 * is not counted, then K2 when the payment is larger than the balance. None when neither applies.
 */
export function recordQuestions(pay: PayStanding, amountCents: number, name: string): PayQuestion[] {
  const questions: PayQuestion[] = [];
  const notCounted = notCountedWords(pay);
  if (notCounted.length > 0) {
    questions.push({
      title: `Record this payment while ${name}'s pay is not all counted?`,
      lines: [`${notCounted.map((part, i) => (i === 0 ? part[0].toUpperCase() + part.slice(1) : part)).join(', and ')}.`, `The balance of ${balanceWords(pay.balanceCents).words.toLowerCase().replace(/^settled$/, '$0.00, settled,')} does not include them.`],
      confirm: 'Record anyway',
    });
  }
  if (amountCents > pay.balanceCents) {
    const over = amountCents - Math.max(pay.balanceCents, 0);
    questions.push({
      title: `This pays ${formatCents(over)} more than ${name} is owed. Record it as an advance?`,
      lines: [pay.balanceCents > 0 ? `${name} is owed ${formatCents(pay.balanceCents)}; this payment is ${formatCents(amountCents)}.` : pay.balanceCents === 0 ? `${name} is owed nothing; this payment is ${formatCents(amountCents)}.` : `${name} is already overpaid by ${formatCents(-pay.balanceCents)}; this payment is ${formatCents(amountCents)}.`],
      confirm: 'Record as an advance',
    });
  }
  return questions;
}

/** Why a member cannot be deleted, or null when they can (K3 and the ruling of 2026-10-15). `uncertain`: records of theirs not in shape or that cannot add up. */
export type DeleteRefusal = { code: 'MEMBER_HAS_BALANCE' | 'MEMBER_HAS_OUTSTANDING'; message: string; hint: string };

export function deleteRefusal(pay: PayStanding, uncertain: number, name: string | null): DeleteRefusal | null {
  const who = name ?? 'This team member';
  const hint = 'Deactivate them instead. Nothing was deleted.';
  const outstanding = notCountedWords(pay);
  if (pay.balanceCents !== 0) {
    const tail = outstanding.length > 0 ? `, and ${outstanding.join(', and ')}` : '';
    return { code: 'MEMBER_HAS_BALANCE', message: `${who}'s balance is ${balanceWords(pay.balanceCents).words}${tail}, so they cannot be deleted.`, hint };
  }
  if (uncertain > 0 || pay.cannotAddUp > 0) {
    const n = uncertain + pay.cannotAddUp;
    return { code: 'MEMBER_HAS_BALANCE', message: `${who}'s balance cannot be worked out (${n === 1 ? '1 record cannot be read' : `${n} records cannot be read`}), so they cannot be deleted.`, hint };
  }
  if (outstanding.length > 0) {
    return { code: 'MEMBER_HAS_OUTSTANDING', message: `${who} ${outstanding.length === 1 && pay.noAmount === 0 ? 'has' : 'has'} ${outstanding.join(', and ')}, so they cannot be deleted.`.replace(`${who} has ${outstanding[0]}`, `${who}: ${outstanding[0]}`), hint };
  }
  return null;
}
