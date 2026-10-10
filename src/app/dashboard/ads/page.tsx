"use client";

import { DashboardShell, useMe } from "@/components/dashboard-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  PlayCircle, Loader2, Gift, CheckCircle2, Flame, Crown, Clock,
  Sparkles, ArrowRight, X, Volume2, Eye,
} from "lucide-react";
import { useEffect, useState, useRef } from "react";

interface AdData {
  id: string;
  title: string;
  body: string;
  brand: string;
  color: string;
  durationSec: number;
}

type Status = "IDLE" | "LOADING" | "PLAYING" | "CLAIMING" | "REWARDED" | "EXHAUSTED";

export default function AdsPage() {
  const { me, reload } = useMe();
  const [ad, setAd] = useState<AdData | null>(null);
  const [status, setStatus] = useState<Status>("IDLE");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [remainingToday, setRemainingToday] = useState<number | null>(null);
  const [reward, setReward] = useState<number>(2);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const DAILY_CAP = 15;

  // Reset ad state when leaving playing
  useEffect(() => {
    if (status !== "PLAYING" && intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, [status]);

  async function loadAd() {
    setStatus("LOADING");
    setError(null);
    try {
      const res = await fetch("/api/ads/serve");
      const data = await res.json();
      if (data.capReached) {
        setStatus("EXHAUSTED");
        setRemainingToday(0);
        return;
      }
      if (!res.ok || !data.ad) {
        setStatus("IDLE");
        setError(data.message || data.error || "No ad available");
        return;
      }
      setAd(data.ad);
      setReward(data.reward || 2);
      setRemainingToday(data.remaining);
      setStatus("IDLE");
    } catch (err) {
      setStatus("IDLE");
      setError("Network error");
    }
  }

  async function startAd() {
    if (!ad) {
      await loadAd();
      return;
    }
    setStatus("PLAYING");
    setSecondsLeft(ad.durationSec);
    intervalRef.current = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          // Auto-enable claim when timer hits 0
          setStatus("CLAIMING");
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }

  async function claim() {
    if (!ad) return;
    setStatus("CLAIMING");
    try {
      const res = await fetch("/api/ads/reward", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          adId: ad.id,
          adTitle: ad.title,
          durationSec: ad.durationSec,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to claim reward");
        setStatus("PLAYING");
        return;
      }
      setStatus("REWARDED");
      setRemainingToday(data.remaining);
      toast.success(`+${data.reward} KES credited to your balance!`);
      reload();
      // Auto-load next ad after 2s
      setTimeout(() => {
        setStatus("IDLE");
        setAd(null);
        loadAd();
      }, 2500);
    } catch (err) {
      setError("Network error");
      setStatus("PLAYING");
    }
  }

  // Load initial ad on mount (if user is verified)
  useEffect(() => {
    if (me?.isVerified) loadAd();
  }, [me?.isVerified]);

  return (
    <DashboardShell>
      <div className="max-w-3xl mx-auto space-y-5">
        {/* Header */}
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <PlayCircle className="w-6 h-6 text-cyan-400" />
              Watch Ads, Earn KES
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Watch sponsored ads and earn 2 KES each. Up to {DAILY_CAP} ads per day.
            </p>
          </div>
          {me && (
            <div className="glass rounded-xl px-3 py-2 text-sm">
              <span className="text-muted-foreground">Watched today: </span>
              <span className="font-bold text-cyan-400">{me.adsWatchedToday || 0}</span>
              <span className="text-muted-500"> / {DAILY_CAP}</span>
            </div>
          )}
        </div>

        {/* Daily progress */}
        {me && (
          <Card className="glass border-cyan-500/20 rounded-2xl">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Flame className="w-4 h-4 text-cyan-400" />
                  <span className="text-sm font-medium">Today's ad limit</span>
                </div>
                <span className="text-sm text-muted-foreground">
                  {(me.adsWatchedToday || 0)} / {DAILY_CAP} watched · {DAILY_CAP - (me.adsWatchedToday || 0)} left
                </span>
              </div>
              <Progress
                value={Math.min(100, ((me.adsWatchedToday || 0) / DAILY_CAP) * 100)}
                className="h-2 bg-white/5 [&>div]:bg-gradient-to-r [&>div]:from-cyan-500 [&>div]:to-cyan-400"
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground mt-2">
                <span>Earned today from ads: <span className="text-cyan-400 font-semibold">{(me.adsWatchedToday || 0) * 2} KES</span></span>
                <span>Max daily: <span className="text-cyan-400 font-semibold">{DAILY_CAP * 2} KES</span></span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Ad player */}
        <Card className="glass border-white/5 rounded-2xl overflow-hidden">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Eye className="w-5 h-5 text-cyan-400" />
              {status === "PLAYING" ? "Ad playing..." :
               status === "REWARDED" ? "Reward claimed!" :
               status === "EXHAUSTED" ? "Daily limit reached" :
               "Ready to watch"}
            </CardTitle>
            <CardDescription>
              {status === "IDLE" && "Click play to start watching. Stay on this page until the timer completes."}
              {status === "LOADING" && "Loading ad..."}
              {status === "PLAYING" && "Keep this page open. You'll be able to claim your reward once the timer ends."}
              {status === "CLAIMING" && "Submitting your watch for reward..." }
              {status === "REWARDED" && "Your reward has been credited. Loading next ad..."}
              {status === "EXHAUSTED" && "You've watched all your ads for today. Come back tomorrow!"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">

            {/* IDLE / not yet started */}
            {status === "IDLE" && ad && (
              <div
                className="aspect-video rounded-xl flex flex-col items-center justify-center p-6 text-center relative overflow-hidden"
                style={{ background: `linear-gradient(135deg, ${ad.color}15, ${ad.color}05), #040a13` }}
              >
                <div className="absolute top-3 left-3 flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                  <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full" /> Sponsored
                </div>
                <div className="absolute top-3 right-3">
                  <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30 border">
                    <Gift className="w-3 h-3 mr-1" /> {reward} KES
                  </Badge>
                </div>
                <div
                  className="w-16 h-16 rounded-2xl flex items-center justify-center mb-3 text-2xl font-bold"
                  style={{ backgroundColor: `${ad.color}30`, color: ad.color }}
                >
                  {ad.brand.charAt(0)}
                </div>
                <h3 className="text-lg font-bold mb-1">{ad.title}</h3>
                <p className="text-sm text-muted-foreground max-w-md">{ad.body}</p>
                <p className="text-xs text-muted-foreground mt-3">{ad.durationSec}s watch · {ad.brand}</p>
              </div>
            )}

            {/* PLAYING */}
            {status === "PLAYING" && ad && (
              <div
                className="aspect-video rounded-xl flex flex-col items-center justify-center p-6 text-center relative overflow-hidden"
                style={{ background: `linear-gradient(135deg, ${ad.color}25, ${ad.color}08), #040a13` }}
              >
                <div className="absolute top-3 left-3 flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                  <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse" /> Ad playing
                </div>
                <div className="absolute top-3 right-3 flex items-center gap-1 text-xs text-muted-foreground">
                  <Volume2 className="w-3 h-3" /> Muted
                </div>
                <div
                  className="w-20 h-20 rounded-2xl flex items-center justify-center mb-3 text-3xl font-bold animate-pulse-glow"
                  style={{ backgroundColor: `${ad.color}40`, color: ad.color }}
                >
                  {ad.brand.charAt(0)}
                </div>
                <h3 className="text-xl font-bold mb-2">{ad.title}</h3>
                <p className="text-sm text-muted-foreground max-w-md mb-2">{ad.body}</p>
                <div className="w-16 h-16 rounded-full border-2 border-cyan-400 flex items-center justify-center mt-3">
                  <span className="text-2xl font-bold text-cyan-400">{secondsLeft}</span>
                </div>
                <p className="text-[10px] text-muted-foreground mt-2 uppercase tracking-wider">Do not close this window</p>
              </div>
            )}

            {/* CLAIMING (auto-transition from PLAYING — submit immediately) */}
            {status === "CLAIMING" && (
              <div className="aspect-video rounded-xl flex flex-col items-center justify-center text-center">
                <Loader2 className="w-10 h-10 text-cyan-400 animate-spin" />
                <p className="text-sm text-muted-foreground mt-2">Verifying watch...</p>
              </div>
            )}

            {/* REWARDED */}
            {status === "REWARDED" && (
              <div className="aspect-video rounded-xl flex flex-col items-center justify-center text-center bg-emerald-500/10 border border-emerald-500/30">
                <CheckCircle2 className="w-16 h-16 text-emerald-400 mb-2" />
                <h3 className="text-xl font-bold text-emerald-400">+{reward} KES!</h3>
                <p className="text-sm text-muted-foreground mt-1">Credited to your balance.</p>
              </div>
            )}

            {/* EXHAUSTED */}
            {status === "EXHAUSTED" && (
              <div className="aspect-video rounded-xl flex flex-col items-center justify-center text-center">
                <Crown className="w-12 h-12 text-amber-400 mb-2 opacity-70" />
                <h3 className="text-lg font-bold">Daily ad limit reached</h3>
                <p className="text-sm text-muted-foreground mt-1">You've earned all you can from ads today.</p>
                <p className="text-xs text-muted-foreground mt-2">Come back tomorrow for {DAILY_CAP} more ads.</p>
              </div>
            )}

            {/* Initial loading */}
            {status === "LOADING" && (
              <div className="aspect-video rounded-xl flex items-center justify-center">
                <Loader2 className="w-10 h-10 text-cyan-400 animate-spin" />
              </div>
            )}

            {error && (
              <div className="rounded-lg p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-sm text-center">
                {error}
              </div>
            )}

            {/* Action button */}
            <div className="flex gap-2">
              {status === "IDLE" && ad && (
                <>
                  <Button
                    onClick={startAd}
                    size="lg"
                    className="flex-1 bg-gradient-to-r from-cyan-500 to-cyan-600 text-slate-950 hover:from-cyan-400 hover:to-cyan-500 glow font-semibold h-12"
                  >
                    <PlayCircle className="w-5 h-5 mr-2" />
                    Play & earn {reward} KES
                  </Button>
                  <Button onClick={loadAd} variant="outline" size="lg" className="glass h-12">
                    Skip ad
                  </Button>
                </>
              )}
              {status === "PLAYING" && (
                <Button disabled size="lg" className="flex-1 h-12">
                  <Clock className="w-4 h-4 mr-2" /> Watch for {secondsLeft}s...
                </Button>
              )}
              {status === "EXHAUSTED" && (
                <Button asChild variant="outline" size="lg" className="flex-1 glass h-12">
                  <a href="/dashboard/tasks">
                    Try tasks instead <ArrowRight className="w-4 h-4 ml-1" />
                  </a>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Helper cards */}
        <div className="grid sm:grid-cols-3 gap-3">
          <Card className="glass border-white/5 rounded-2xl">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-cyan-500/15 flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-cyan-400" />
              </div>
              <div>
                <p className="text-sm font-semibold">2 KES / ad</p>
                <p className="text-xs text-muted-foreground">Instant credit to balance</p>
              </div>
            </CardContent>
          </Card>
          <Card className="glass border-white/5 rounded-2xl">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center">
                <Flame className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <p className="text-sm font-semibold">{DAILY_CAP} ads / day</p>
                <p className="text-xs text-muted-foreground">Resets at midnight</p>
              </div>
            </CardContent>
          </Card>
          <Card className="glass border-white/5 rounded-2xl">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center">
                <Gift className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <p className="text-sm font-semibold">{DAILY_CAP * 2} KES / day max</p>
                <p className="text-xs text-muted-foreground">From ads alone</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardShell>
  );
}
