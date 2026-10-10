"use client";

import { DashboardShell, useMe } from "@/components/dashboard-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { ArrowUpFromLine, Loader2, CheckCircle2, XCircle, Shield } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Status = "IDLE" | "INITIATING" | "SUCCESS" | "FAILED";

export default function WithdrawalPage() {
  const { me, reload } = useMe();
  const router = useRouter();
  const [amount, setAmount] = useState<number>(100);
  const [phone, setPhone] = useState("");
  const [status, setStatus] = useState<Status>("IDLE");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (me) setPhone(me.phone);
  }, [me]);

  async function initiate() {
    if (!amount || amount < 50) { toast.error("Minimum withdrawal is 50 KES"); return; }
    if (me && amount > me.balance) { toast.error(`Insufficient balance. Available: ${me.balance} KES`); return; }
    setStatus("INITIATING");
    setError(null);
    try {
      const res = await fetch("/api/payments/withdraw", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount, phone: phone || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus("FAILED");
        setError(data.error || "Withdrawal failed");
        toast.error(data.error || "Withdrawal failed");
        return;
      }
      setStatus("SUCCESS");
      toast.success("Withdrawal initiated! M-Pesa will arrive within 1-2 minutes.");
      reload();
      setTimeout(() => router.push("/dashboard/transactions"), 2500);
    } catch (err) {
      setStatus("FAILED");
      setError("Network error");
    }
  }

  return (
    <DashboardShell>
      <div className="max-w-md mx-auto space-y-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Withdraw to M-Pesa</h1>
          <p className="text-sm text-muted-foreground mt-1">Instant B2C payout via SwiftWallet.</p>
        </div>

        <Card className="glass border-white/5 rounded-2xl">
          <CardContent className="p-6 space-y-5">
            <div className="text-center space-y-2 py-2">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gradient-to-br from-cyan-500/20 to-cyan-500/5 mb-1">
                {status === "INITIATING" && <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />}
                {status === "SUCCESS" && <CheckCircle2 className="w-8 h-8 text-emerald-400" />}
                {status === "FAILED" && <XCircle className="w-8 h-8 text-red-400" />}
                {(status === "IDLE") && <ArrowUpFromLine className="w-8 h-8 text-cyan-400" />}
              </div>
              {me && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider">Available</p>
                  <p className="text-2xl font-bold text-emerald-400">{me.balance.toLocaleString()} KES</p>
                </div>
              )}
            </div>

            {(status === "IDLE" || status === "FAILED") && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="amount">Amount (KES)</Label>
                  <Input
                    id="amount"
                    type="number"
                    min={50}
                    max={70000}
                    value={amount}
                    onChange={e => setAmount(Number(e.target.value))}
                    className="bg-white/5 border-white/10 text-lg font-semibold"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="phone">Send to (M-Pesa phone)</Label>
                  <Input
                    id="phone"
                    type="tel"
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    className="bg-white/5 border-white/10"
                    placeholder="0712345678"
                  />
                  <p className="text-[11px] text-muted-foreground">Default: your registered phone.</p>
                </div>

                <Button onClick={initiate} size="lg" className="w-full bg-gradient-to-r from-cyan-500 to-cyan-600 text-slate-950 hover:from-cyan-400 hover:to-cyan-500 glow font-semibold">
                  Withdraw {amount.toLocaleString()} KES
                </Button>

                {status === "FAILED" && error && (
                  <div className="text-sm text-red-400 text-center">{error}</div>
                )}
              </>
            )}

            {status === "INITIATING" && (
              <div className="text-center py-4">
                <p className="text-sm text-muted-foreground">Initiating B2C payout...</p>
              </div>
            )}

            {status === "SUCCESS" && (
              <div className="text-center space-y-2 py-4">
                <h3 className="text-lg font-bold text-emerald-400">Withdrawal initiated!</h3>
                <p className="text-sm text-muted-foreground">{amount.toLocaleString()} KES is being sent to {phone}. M-Pesa will arrive within 1-2 minutes.</p>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="rounded-xl p-3 bg-white/5 border border-white/10 text-xs text-muted-foreground flex items-start gap-2">
          <Shield className="w-4 h-4 text-cyan-400 mt-0.5 shrink-0" />
          <p>
            Withdrawals are processed via SwiftWallet v3 B2C API. Balance is held during payout and refunded automatically if the transaction fails.
          </p>
        </div>
      </div>
    </DashboardShell>
  );
}
