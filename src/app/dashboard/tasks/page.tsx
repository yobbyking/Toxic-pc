"use client";

import { DashboardShell, useMe } from "@/components/dashboard-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "sonner";
import {
  ListChecks, Clock, Wallet, Loader2, CheckCircle2, Trophy,
  Sparkles, FileText, BarChart3, MessageSquare,
} from "lucide-react";
import { useEffect, useState } from "react";

interface Task {
  id: string;
  title: string;
  description: string;
  category: 'SURVEY' | 'QUESTION' | 'POLL' | 'OPINION';
  payout: number;
  estimatedMinutes: number;
  questionCount: number;
  myStatus: string | null;
  canDo: boolean;
  completedCount: number;
  maxAttempts: number;
}

interface Question {
  id: string;
  text: string;
  type: 'radio' | 'text';
  options?: string[];
}

export default function TasksPage() {
  const { me, reload } = useMe();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Task | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Load + seed (if empty)
  useEffect(() => {
    (async () => {
      try {
        // Try to seed if first visit (only seeds if no tasks exist)
        await fetch("/api/tasks/list", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seed: true }) });
      } catch {}
      try {
        const res = await fetch("/api/tasks/list");
        if (res.ok) {
          const data = await res.json();
          setTasks(data.tasks || []);
        }
      } catch {} finally {
        setLoading(false);
      }
    })();
  }, []);

  // Fetch full task details when one is selected
  useEffect(() => {
    if (!selected) return;
    // We don't have a get-by-id endpoint yet — parse from the task list
    // since the list already returns questionCount. We'll fetch fresh on submit.
    // For now, derive questions client-side via a new endpoint below.
    // Actually, let's fetch via the list endpoint and look up by id
    (async () => {
      try {
        // For now, use a separate endpoint to fetch single task questions
        const res = await fetch(`/api/tasks/list?taskId=${selected.id}`);
        if (res.ok) {
          const data = await res.json();
          if (data.task?.questions) {
            setQuestions(JSON.parse(data.task.questions));
          }
        }
      } catch {}
    })();
  }, [selected]);

  const openTask = (task: Task) => {
    setSelected(task);
    setAnswers({});
  };

  const submit = async () => {
    if (!selected) return;
    // Validate all answers present
    const unanswered = questions.filter(q => !answers[q.id] || answers[q.id].trim() === "");
    if (unanswered.length > 0) {
      toast.error("Please answer all questions before submitting");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/tasks/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskId: selected.id,
          answers: questions.map(q => ({ questionId: q.id, value: answers[q.id] })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Submission failed");
        return;
      }
      toast.success(`Task completed! +${data.reward} KES credited.`);
      setSelected(null);
      setAnswers({});
      // Reload tasks
      const listRes = await fetch("/api/tasks/list");
      if (listRes.ok) {
        const listData = await listRes.json();
        setTasks(listData.tasks || []);
      }
      reload();
    } catch (err) {
      toast.error("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const categoryIcon = (cat: string) => {
    if (cat === 'POLL') return BarChart3;
    if (cat === 'QUESTION') return MessageSquare;
    return FileText;
  };

  const categoryColor = (cat: string) => {
    if (cat === 'POLL') return 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30';
    if (cat === 'QUESTION') return 'bg-purple-500/15 text-purple-400 border-purple-500/30';
    if (cat === 'OPINION') return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
    return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
  };

  const totalAvailable = tasks.reduce((sum, t) => sum + t.payout, 0);

  return (
    <DashboardShell>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ListChecks className="w-6 h-6 text-emerald-400" />
              Tasks & Surveys
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Complete tasks to earn. Each task pays instantly to your balance.
            </p>
          </div>
          <div className="flex gap-2">
            <div className="glass rounded-xl px-3 py-2 text-sm">
              <span className="text-muted-foreground">Available tasks: </span>
              <span className="font-bold text-emerald-400">{tasks.length}</span>
            </div>
            <div className="glass rounded-xl px-3 py-2 text-sm">
              <span className="text-muted-foreground">Total payout: </span>
              <span className="font-bold text-amber-400">{totalAvailable} KES</span>
            </div>
            {me && (
              <div className="glass rounded-xl px-3 py-2 text-sm">
                <span className="text-muted-foreground">Completed: </span>
                <span className="font-bold text-cyan-400">{me.tasksCompleted}</span>
              </div>
            )}
          </div>
        </div>

        {/* Tasks grid */}
        {loading ? (
          <div className="text-center py-12 text-muted-foreground">
            <Loader2 className="w-8 h-8 mx-auto animate-spin" />
            <p className="text-sm mt-2">Loading tasks...</p>
          </div>
        ) : tasks.length === 0 ? (
          <Card className="glass border-white/5 rounded-2xl">
            <CardContent className="p-12 text-center text-muted-foreground">
              <Trophy className="w-12 h-12 mx-auto mb-3 opacity-50 text-amber-400" />
              <p className="text-lg font-semibold text-foreground">All caught up!</p>
              <p className="text-sm mt-1">No tasks available right now. Check back later for new earning opportunities.</p>
              <Button onClick={() => window.location.reload()} variant="outline" className="mt-4 glass">
                Refresh
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {tasks.map(task => {
              const Icon = categoryIcon(task.category);
              return (
                <Card
                  key={task.id}
                  className="glass border-white/5 rounded-2xl hover:border-emerald-500/30 transition-all cursor-pointer group"
                  onClick={() => openTask(task)}
                >
                  <CardContent className="p-5 space-y-3">
                    <div className="flex items-start justify-between">
                      <Badge className={`${categoryColor(task.category)} border`}>
                        <Icon className="w-3 h-3 mr-1" />
                        {task.category}
                      </Badge>
                      <div className="text-right">
                        <p className="text-2xl font-bold text-amber-400">{task.payout}</p>
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">KES</p>
                      </div>
                    </div>
                    <div>
                      <h3 className="font-semibold leading-tight">{task.title}</h3>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{task.description}</p>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground pt-2 border-t border-white/5">
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {task.estimatedMinutes} min</span>
                      <span className="flex items-center gap-1"><ListChecks className="w-3 h-3" /> {task.questionCount} Q</span>
                    </div>
                    <Button
                      size="sm"
                      className="w-full bg-gradient-to-r from-emerald-500 to-cyan-500 text-slate-950 hover:from-emerald-400 hover:to-cyan-400 group-hover:glow"
                    >
                      Start task →
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Task modal */}
      <Dialog open={!!selected} onOpenChange={(open) => !open && !submitting && setSelected(null)}>
        <DialogContent className="glass-strong max-w-lg rounded-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <Badge className={selected ? categoryColor(selected.category) : ''}>
                {selected?.category}
              </Badge>
              <div className="text-right">
                <span className="text-xl font-bold text-amber-400">{selected?.payout}</span>
                <span className="text-xs text-muted-foreground ml-1">KES reward</span>
              </div>
            </div>
            <DialogTitle className="text-xl mt-2">{selected?.title}</DialogTitle>
            <DialogDescription>{selected?.description}</DialogDescription>
          </DialogHeader>

          {questions.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">Loading questions...</div>
          ) : (
            <div className="space-y-5 py-2">
              {questions.map((q, i) => (
                <div key={q.id} className="space-y-2">
                  <Label className="text-sm font-medium flex items-start gap-2">
                    <span className="w-5 h-5 rounded-full bg-emerald-500/15 text-emerald-400 text-[10px] flex items-center justify-center shrink-0 mt-0.5">
                      {i + 1}
                    </span>
                    <span>{q.text}</span>
                  </Label>
                  {q.type === 'radio' && q.options ? (
                    <RadioGroup
                      value={answers[q.id] || ""}
                      onValueChange={(v) => setAnswers(a => ({ ...a, [q.id]: v }))}
                      className="pl-7 space-y-1.5"
                    >
                      {q.options.map((opt, oi) => (
                        <div key={oi} className="flex items-center space-x-2 rounded-lg px-2 py-1.5 hover:bg-white/5 cursor-pointer">
                          <RadioGroupItem value={opt} id={`${q.id}-${oi}`} />
                          <Label htmlFor={`${q.id}-${oi}`} className="text-sm cursor-pointer flex-1">{opt}</Label>
                        </div>
                      ))}
                    </RadioGroup>
                  ) : (
                    <Textarea
                      value={answers[q.id] || ""}
                      onChange={(e) => setAnswers(a => ({ ...a, [q.id]: e.target.value }))}
                      placeholder="Type your answer..."
                      className="ml-7 bg-white/5 border-white/10"
                      rows={4}
                    />
                  )}
                </div>
              ))}

              <div className="flex gap-2 pt-3 border-t border-white/5">
                <Button
                  variant="outline"
                  onClick={() => !submitting && setSelected(null)}
                  disabled={submitting}
                  className="glass flex-1"
                >
                  Cancel
                </Button>
                <Button
                  onClick={submit}
                  disabled={submitting}
                  className="flex-1 bg-gradient-to-r from-emerald-500 to-cyan-500 text-slate-950 hover:from-emerald-400 hover:to-cyan-400 glow"
                >
                  {submitting ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Submitting...</>
                  ) : (
                    <><CheckCircle2 className="w-4 h-4 mr-2" /> Submit & earn {selected?.payout} KES</>
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </DashboardShell>
  );
}
