'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Star, ChevronLeft, ChevronRight, Loader2, User2, Mail } from 'lucide-react'
import type { Question } from '@/lib/encuestas'

type Answer = string | number | string[] | undefined

interface Props {
  slug:        string
  title:       string
  description: string | null
  questions:   Question[]
  campaign:    string | null
  source:      string | null
  playerToken: string | null
}

type Step =
  | { kind: 'username' }
  | { kind: 'question'; q: Question }
  | { kind: 'email' }

// Regex idéntico al del server (lib/encuestas.ts) — evita round-trip para errores obvios.
const USERNAME_REGEX = /^[a-zA-Z0-9._-]{3,60}$/
const EMAIL_REGEX    = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/**
 * Formulario público. Una "pantalla" por paso — mobile-first.
 *
 * Pasos: username (obligatorio) → cada pregunta → email (opcional).
 * Progress bar arriba + "N de M". Compliance visible siempre.
 */
export function EncuestaForm({
  slug, title, description, questions,
  campaign, source, playerToken,
}: Props) {
  const router = useRouter()

  const steps: Step[] = React.useMemo(() => [
    { kind: 'username' as const },
    ...questions.map(q => ({ kind: 'question' as const, q })),
    { kind: 'email' as const },
  ], [questions])

  const [step, setStep]       = React.useState(0)
  const [username, setUsername] = React.useState('')
  const [email, setEmail]     = React.useState('')
  const [answers, setAnswers] = React.useState<Record<string, Answer>>({})
  const [others, setOthers]   = React.useState<Record<string, string>>({}) // { qid: 'texto libre' }
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError]     = React.useState<string | null>(null)

  const total   = steps.length
  const current = steps[step]
  const pct     = ((step + 1) / total) * 100
  const isLast  = step === total - 1

  // ── Validación del paso actual ─────────────────────────────────────────────
  const currentValid = React.useMemo(() => {
    if (current.kind === 'username') {
      return USERNAME_REGEX.test(username.trim())
    }
    if (current.kind === 'email') {
      const e = email.trim()
      return e === '' || EMAIL_REGEX.test(e)
    }
    const q = current.q
    if (!q.required) return true
    const v = answers[q.id]
    if (v === undefined || v === null) return false
    if (typeof v === 'string')  return v.trim() !== ''
    if (Array.isArray(v))       return v.length > 0
    if (typeof v === 'number')  return true
    return false
  }, [current, username, email, answers])

  function updateAnswer(qid: string, v: Answer) {
    setAnswers(prev => ({ ...prev, [qid]: v }))
  }

  function updateOther(qid: string, v: string) {
    setOthers(prev => ({ ...prev, [qid]: v }))
  }

  function goPrev() {
    setError(null)
    setStep(s => Math.max(0, s - 1))
  }
  function goNext() {
    if (!currentValid) {
      setError(current.kind === 'email'
        ? 'El email no parece válido'
        : current.kind === 'username'
          ? 'El username debe tener entre 3 y 60 caracteres (letras, números, . _ -)'
          : 'Esta pregunta es obligatoria')
      return
    }
    setError(null)
    setStep(s => Math.min(total - 1, s + 1))
  }

  async function submit() {
    if (!currentValid) { goNext(); return }
    setError(null)
    setSubmitting(true)

    // Merge de "otros (especificar)" al payload de answers.
    const merged: Record<string, unknown> = { ...answers }
    for (const q of questions) {
      if (q.allowOther) {
        const selected = merged[q.id]
        const otherKey = q.otherOption ?? 'Otros'
        if (Array.isArray(selected) && selected.includes(otherKey)) {
          const txt = (others[q.id] ?? '').trim()
          if (txt) merged[`${q.id}_other`] = txt
        }
      }
    }

    try {
      const res = await fetch('/api/encuestas/respuestas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          username:     username.trim(),
          email:        email.trim() || null,
          answers:      merged,
          campaign,
          source,
          player_token: playerToken,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setError(body?.error ?? 'No pudimos enviar la encuesta')
        setSubmitting(false)
        return
      }
      router.push('/encuesta/gracias')
    } catch {
      setError('Sin conexión. Probá de nuevo.')
      setSubmitting(false)
    }
  }

  // ── Header persistente ─────────────────────────────────────────────────────
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="text-lg sm:text-xl">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        <div className="mt-4 flex items-center gap-3">
          <Progress value={pct} className="flex-1" />
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            {step + 1} de {total}
          </span>
        </div>
      </CardHeader>

      <CardContent className="py-6 space-y-6">
        {current.kind === 'username' ? (
          <UsernameStep value={username} onChange={setUsername} />
        ) : current.kind === 'email' ? (
          <EmailStep value={email} onChange={setEmail} />
        ) : (
          <QuestionStep
            question={current.q}
            value={answers[current.q.id]}
            other={others[current.q.id] ?? ''}
            onChange={v => updateAnswer(current.q.id, v)}
            onOtherChange={txt => updateOther(current.q.id, txt)}
          />
        )}

        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </CardContent>

      <div className="flex items-center justify-between gap-2 border-t px-4 py-3 bg-muted/30">
        <Button variant="ghost" onClick={goPrev} disabled={step === 0 || submitting}>
          <ChevronLeft />
          Atrás
        </Button>
        {isLast ? (
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="animate-spin" /> : null}
            Enviar
          </Button>
        ) : (
          <Button onClick={goNext} disabled={submitting}>
            Siguiente
            <ChevronRight />
          </Button>
        )}
      </div>
    </Card>
  )
}

// ── Steps ────────────────────────────────────────────────────────────────────

function UsernameStep({
  value, onChange,
}: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-primary">
        <User2 className="size-5" />
        <h2 className="font-heading text-base sm:text-lg font-medium">
          ¿Cuál es tu username? <span className="text-destructive">*</span>
        </h2>
      </div>
      <Input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="tu_usuario"
        autoComplete="username"
        autoFocus
        maxLength={60}
        className="text-base h-11"
        inputMode="text"
      />
      <ComplianceNote />
    </div>
  )
}

function EmailStep({
  value, onChange,
}: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-primary">
        <Mail className="size-5" />
        <h2 className="font-heading text-base sm:text-lg font-medium">
          Tu email <span className="text-xs font-normal text-muted-foreground">(opcional)</span>
        </h2>
      </div>
      <Input
        type="email"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="tu@email.com"
        autoComplete="email"
        maxLength={254}
        className="text-base h-11"
        inputMode="email"
      />
      <p className="text-xs text-muted-foreground leading-relaxed">
        Es opcional — sólo lo usamos para mandarte info relevante del casino
        (promos y bonos). Podés dejarlo en blanco y clickear <span className="font-medium">Enviar</span>.
      </p>
    </div>
  )
}

function ComplianceNote() {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
      Esta encuesta es <span className="font-medium text-foreground">voluntaria</span>.
      Usamos tu username para <span className="font-medium text-foreground">identificar tu cuenta</span> y
      poder ofrecerte bonos. El email es opcional y sólo lo usamos para enviarte
      información relevante del casino.
    </div>
  )
}

// ── Renderer de una pregunta ─────────────────────────────────────────────────

function QuestionStep({
  question, value, other, onChange, onOtherChange,
}: {
  question:      Question
  value:         Answer
  other:         string
  onChange:      (v: Answer) => void
  onOtherChange: (v: string) => void
}) {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="font-heading text-base sm:text-lg font-medium leading-snug">
          {question.label}
          {question.required ? <span className="text-destructive ml-1">*</span> : null}
        </h2>
        {question.helpText
          ? <p className="text-xs text-muted-foreground">{question.helpText}</p>
          : null}
      </div>
      <QuestionInput
        question={question}
        value={value}
        other={other}
        onChange={onChange}
        onOtherChange={onOtherChange}
      />
    </div>
  )
}

function QuestionInput({
  question, value, other, onChange, onOtherChange,
}: {
  question:      Question
  value:         Answer
  other:         string
  onChange:      (v: Answer) => void
  onOtherChange: (v: string) => void
}) {
  switch (question.type) {
    case 'rating':
      return <RatingInput question={question} value={typeof value === 'number' ? value : null} onChange={onChange} />
    case 'text':
      return (
        <Textarea
          value={typeof value === 'string' ? value : ''}
          onChange={e => onChange(e.target.value)}
          maxLength={500}
          rows={4}
          placeholder="Escribí acá tu respuesta..."
          className="text-base"
        />
      )
    case 'select':
      return (
        <RadioGroup
          value={typeof value === 'string' ? value : null}
          onValueChange={v => onChange(typeof v === 'string' ? v : undefined)}
        >
          {(question.options ?? []).map(opt => (
            <label
              key={opt}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-input hover:bg-muted/50 cursor-pointer transition-colors"
            >
              <RadioGroupItem value={opt} />
              <span className="text-sm sm:text-base">{opt}</span>
            </label>
          ))}
        </RadioGroup>
      )
    case 'multiple': {
      const selected = Array.isArray(value) ? value : []
      const otherKey = question.otherOption ?? 'Otros'
      const otherActive = question.allowOther && selected.includes(otherKey)
      return (
        <div className="grid gap-2">
          {(question.options ?? []).map(opt => {
            const checked = selected.includes(opt)
            return (
              <label
                key={opt}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-input hover:bg-muted/50 cursor-pointer transition-colors"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={c => {
                    const next = c
                      ? [...selected, opt]
                      : selected.filter(x => x !== opt)
                    onChange(next)
                  }}
                />
                <span className="text-sm sm:text-base">{opt}</span>
              </label>
            )
          })}
          {otherActive ? (
            <Input
              value={other}
              onChange={e => onOtherChange(e.target.value)}
              placeholder={question.otherLabel ?? 'Contanos cuál'}
              maxLength={200}
              className="mt-1"
              autoFocus
            />
          ) : null}
        </div>
      )
    }
  }
}

// ── Rating: estrellas ≤5, NPS 0-10 con colores, escala 1-10 sin NPS ──────────

function RatingInput({
  question, value, onChange,
}: {
  question: Question
  value:    number | null
  onChange: (v: number) => void
}) {
  const min = question.min ?? 1
  const max = question.max ?? 5
  const options = Array.from({ length: max - min + 1 }, (_, i) => min + i)

  // Reglas de UI:
  //   - hasta 5 → estrellas
  //   - min=0, max=10 → NPS (colores por tramo)
  //   - resto → escala numérica plana con labels
  if (max <= 5) {
    return (
      <div className="flex items-center gap-1 sm:gap-2" role="radiogroup" aria-label={question.label}>
        {options.map(n => {
          const active = value !== null && n <= value
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value === n}
              aria-label={`${n} de ${max}`}
              onClick={() => onChange(n)}
              className="p-1.5 sm:p-2 rounded-md hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Star
                className={active
                  ? 'fill-yellow-400 stroke-yellow-500 size-8 sm:size-9'
                  : 'stroke-muted-foreground size-8 sm:size-9'}
              />
            </button>
          )
        })}
      </div>
    )
  }

  const isNps = min === 0 && max === 10

  return (
    <div className="space-y-3">
      <div className={
        isNps
          ? 'grid grid-cols-6 gap-1.5 sm:grid-cols-11 sm:gap-1.5'
          : 'grid grid-cols-5 gap-1.5 sm:grid-cols-10 sm:gap-1.5'
      } role="radiogroup" aria-label={question.label}>
        {options.map(n => {
          const active = value === n
          const tone = isNps ? npsTone(n) : 'neutral'
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(n)}
              className={ratingCellClass(active, tone)}
            >
              {n}
            </button>
          )
        })}
      </div>

      <div className="flex justify-between text-[11px] sm:text-xs text-muted-foreground px-0.5">
        <span>{isNps ? 'Nada probable' : 'Muy insatisfecho'}</span>
        <span>{isNps ? 'Altamente probable' : 'Muy satisfecho'}</span>
      </div>

      {isNps && value !== null ? (
        <p className={npsBadgeClass(value)}>
          {npsLabel(value)}
        </p>
      ) : null}
    </div>
  )
}

// ── NPS helpers ──────────────────────────────────────────────────────────────

type NpsTone = 'detractor' | 'passive' | 'promoter' | 'neutral'

function npsTone(n: number): NpsTone {
  if (n <= 6) return 'detractor'
  if (n <= 8) return 'passive'
  return 'promoter'
}

function ratingCellClass(active: boolean, tone: NpsTone): string {
  const base = 'h-10 rounded-md text-sm font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
  if (!active) {
    // Cuando no está activo, mostramos el color suave del tramo (NPS) o neutro.
    const idle: Record<NpsTone, string> = {
      detractor: 'bg-background border-input text-foreground hover:bg-red-500/10 hover:border-red-500/40',
      passive:   'bg-background border-input text-foreground hover:bg-yellow-500/10 hover:border-yellow-500/40',
      promoter:  'bg-background border-input text-foreground hover:bg-emerald-500/10 hover:border-emerald-500/40',
      neutral:   'bg-background border-input hover:bg-muted',
    }
    return `${base} ${idle[tone]}`
  }
  const activeStyles: Record<NpsTone, string> = {
    detractor: 'bg-red-500 text-white border-red-600',
    passive:   'bg-yellow-500 text-white border-yellow-600',
    promoter:  'bg-emerald-500 text-white border-emerald-600',
    neutral:   'bg-primary text-primary-foreground border-primary',
  }
  return `${base} ${activeStyles[tone]}`
}

function npsBadgeClass(v: number): string {
  const tone = npsTone(v)
  const map: Record<NpsTone, string> = {
    detractor: 'inline-flex items-center rounded-md bg-red-500/10 text-red-600 dark:text-red-400 text-xs px-2 py-1 font-medium',
    passive:   'inline-flex items-center rounded-md bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 text-xs px-2 py-1 font-medium',
    promoter:  'inline-flex items-center rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 text-xs px-2 py-1 font-medium',
    neutral:   '',
  }
  return map[tone]
}

function npsLabel(v: number): string {
  const t = npsTone(v)
  if (t === 'detractor') return 'Detractor (0-6)'
  if (t === 'passive')   return 'Pasivo (7-8)'
  return 'Promotor (9-10)'
}
