import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { z } from 'zod';

const ResetSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
  newPassword: z.string().min(6, 'Password must be at least 6 characters'),
});

/**
 * POST /api/auth/reset-password
 * Body: { email, code, newPassword }
 * Verifies the reset code, then updates the Firebase user's password via Admin SDK.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    const parsed = ResetSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid input' }, { status: 400 });
    }
    const { email, code, newPassword } = parsed.data;

    const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user) return NextResponse.json({ error: 'Invalid or expired code' }, { status: 400 });

    if (!user.resetToken || !user.resetTokenExpiresAt) {
      return NextResponse.json({ error: 'No reset code. Request a new one.' }, { status: 400 });
    }
    if (user.resetToken !== code) {
      return NextResponse.json({ error: 'Invalid reset code' }, { status: 400 });
    }
    if (user.resetTokenExpiresAt < new Date()) {
      return NextResponse.json({ error: 'Code expired. Request a new one.' }, { status: 400 });
    }

    // Update the password in Firebase Auth via Admin SDK
    const { updateUserPassword } = await import('@/lib/firebase-admin');
    const updated = await updateUserPassword(user.firebaseUid, newPassword);
    if (!updated) {
      return NextResponse.json({ error: 'Failed to update password (Firebase). Try again.' }, { status: 502 });
    }

    // Clear the reset token
    await db.user.update({
      where: { id: user.id },
      data: { resetToken: null, resetTokenExpiresAt: null },
    });

    return NextResponse.json({ message: 'Password updated successfully. You can now log in.' });
  } catch (err) {
    console.error('[reset-password] error:', err);
    return NextResponse.json({ error: 'Failed to reset password' }, { status: 500 });
  }
}
