# G. Frontend UX / Dead Code Report

Generated: 2026-04-17

---

## campaigns/page.tsx — Lucide-React Imports

Import line 9:
```ts
import { Send, Plus, Loader2, Eye, Play, BarChart2, Shield, Clock, Pause, XCircle,
         CheckCheck, Truck, AlertTriangle, HelpCircle, Trash2, Shuffle,
         UserCheck, UserX } from 'lucide-react'
```

| Icon | Used | Location |
|------|------|----------|
| Send | ✅ | Line 433 (create button), line 597 (ContactStatusBadge) |
| Plus | ✅ | Line 134, 369 |
| Loader2 | ✅ | Line 209, 433 |
| Eye | ✅ | Line 202 |
| Play | ✅ | Line 211 |
| BarChart2 | ✅ | Line 151 |
| Shield | ✅ | Line 182, 418 |
| Clock | ✅ | Line 165, 305 |
| Pause | ✅ | Line 220 |
| XCircle | ✅ | Line 232 |
| CheckCheck | ✅ | Line 596 |
| Truck | ✅ | Line 597 |
| AlertTriangle | ✅ | Line 598 |
| HelpCircle | ✅ | Line 590, 600 |
| Trash2 | ✅ | Line 358 |
| Shuffle | ✅ | Lines 174, 319, 473 |
| UserCheck | ✅ | Lines 184, 392, 499 |
| UserX | ✅ | Lines 185, 393, 500 |

**All imports used.** ✅

---

## contacts/page.tsx — Lucide-React Imports

```ts
import { Search, Upload, UserPlus, List, CheckSquare, X, ChevronDown,
         Loader2, Download, Filter, Pencil } from 'lucide-react'
```

| Icon | Used | Notes |
|------|------|-------|
| Search | ✅ | Filter bar |
| Upload | ✅ | Import button |
| UserPlus | ✅ | Add contact button |
| List | ✅ | Create list button |
| CheckSquare | ✅ | List modal title |
| X | ✅ | Clear search |
| ChevronDown | ✅ | Filter dropdowns |
| Loader2 | ✅ | Loading states |
| Download | ✅ | Download button |
| Filter | ✅ | Filter icon |
| Pencil | ✅ | Inline edit |

**All imports used.** ✅

---

## lines/page.tsx — Lucide-React Imports

```ts
import { RefreshCw, Wifi, WifiOff, QrCode, CheckCircle, Loader2,
         AlertCircle, ExternalLink, KeyRound } from 'lucide-react'
```

| Icon | Used | Notes |
|------|------|-------|
| RefreshCw | ✅ | Refresh button, regenerate QR |
| Wifi | ✅ | Connected indicator |
| WifiOff | ✅ | Disconnected indicator |
| QrCode | ✅ | Vincular button, modal title |
| CheckCircle | ✅ | Connected state |
| Loader2 | ✅ | Loading/creating states |
| AlertCircle | ✅ | Error state |
| ExternalLink | ✅ | Evolution Manager link |
| KeyRound | ✅ | API key input label |

**All imports used.** ✅  
**Note:** `Badge` from `@/components/ui/badge` is imported and used. ✅

---

## warmup/page.tsx — Lucide-React Imports

```ts
import { RefreshCw, Plus, Flame, Pause, Play, Trash2, FileText,
         QrCode, CheckCircle, Loader2, AlertCircle, ExternalLink, KeyRound,
         ArrowRight, Pencil, Wifi, WifiOff } from 'lucide-react'
```

All 17 icons are used within the page (table, modals, status badges). ✅

---

## API Route Callers from Frontend

| API Route | Called From | Method |
|-----------|------------|--------|
| `/api/campaigns` | campaigns/page.tsx:59, 68 | GET, POST |
| `/api/campaigns/[id]` | campaigns/page.tsx:115 | PATCH |
| `/api/campaigns/[id]/send` | campaigns/page.tsx:89 | POST |
| `/api/campaigns/[id]/contacts` | campaigns/page.tsx:107 | GET |
| `/api/contacts` | contacts/page.tsx | GET, POST |
| `/api/contacts/[id]` | contacts/page.tsx | PATCH, DELETE |
| `/api/contacts/import` | contacts/page.tsx | POST |
| `/api/lists` | contacts/page.tsx, campaigns/page.tsx:61 | GET, POST |
| `/api/lines` | lines/page.tsx:39 | GET |
| `/api/lines/qr` | lines/page.tsx:59,91; warmup/page.tsx:190,210 | GET, POST |
| `/api/conversations` | conversations/page.tsx | GET |
| `/api/send` | conversations/page.tsx | POST |
| `/api/dashboard` | app/page.tsx (root dashboard) | GET |
| `/api/warmup` | warmup/page.tsx:84,108 | GET, POST |
| `/api/warmup/[id]` | warmup/page.tsx:142,152,162 | PATCH, DELETE |
| `/api/warmup/[id]/logs` | warmup/page.tsx:168 | GET |
| `/api/warmup/[id]/migrate` | warmup/page.tsx:175 | POST |
| `/api/webhook/evolution` | Evolution API (external, not frontend) | POST |
| `/api/auth/login` | login/page.tsx | POST |
| `/api/auth/logout` | (login page or nav, not confirmed) | POST |

**All 20 routes have at least one caller.** No orphan API routes found. ✅

---

## fetch() Calls Without res.ok Check

| File | Line | Fetch Target | res.ok Checked? |
|------|------|-------------|-----------------|
| campaigns/page.tsx | 59 | `/api/campaigns` (load) | ❌ No |
| campaigns/page.tsx | 61 | `/api/lists` (load) | ❌ No |
| campaigns/page.tsx | 68-72 | `/api/campaigns` POST (createCampaign) | ❌ No |
| campaigns/page.tsx | 107 | `/api/campaigns/${id}/contacts` | ❌ No |
| campaigns/page.tsx | 89-99 | `/api/campaigns/${id}/send` | ✅ Yes |
| campaigns/page.tsx | 115-118 | `/api/campaigns/${id}` PATCH | ❌ No |
| contacts/page.tsx | various | All contact fetches | Mixed — needs line-level check |
| lines/page.tsx | 39 | `/api/lines` | ❌ No (.catch fallback only) |
| warmup/page.tsx | 84 | `/api/warmup` | ❌ No (.catch fallback only) |
| warmup/page.tsx | 108 | `/api/warmup` POST | ✅ Yes (line 120: `if (!res.ok)`) |
| warmup/page.tsx | 142 | `/api/warmup/${id}` PATCH (saveName) | ❌ No |
| warmup/page.tsx | 150-154 | `/api/warmup/${id}` PATCH (toggleStatus) | ❌ No |
| warmup/page.tsx | 162 | `/api/warmup/${id}` DELETE | ❌ No |
| warmup/page.tsx | 168 | `/api/warmup/${id}/logs` | ❌ No |
| warmup/page.tsx | 175-176 | `/api/warmup/${id}/migrate` | ✅ Yes |

**Key risk:** `createCampaign()` (campaigns/page.tsx:65-79) doesn't check `res.ok`. If POST fails (e.g., missing list_id, DB error), the modal closes, form resets, and the user has no indication of failure.

---

## Modal State Reset Behavior

### campaigns/page.tsx

| Modal | onOpenChange | State Reset |
|-------|------------|-------------|
| New campaign | `v => { setShowNew(v); if (!v) { reset all form fields } }` | ✅ Resets form, messages, previewIdx, creating, sendError |
| Campaign detail | `() => setSelected(null)` | ✅ Clears selected (derived state) |

### contacts/page.tsx

| Modal | onOpenChange | State Reset |
|-------|------------|-------------|
| Import | `v => { setShowImport(v); if (!v) { reset importRows, importResult, importing, importPanel, importGaming } }` | ✅ |
| Add contact | `v => { setShowAdd(v); if (!v) { reset all newXxx fields + addError } }` | ✅ |
| Create list | `v => { setShowList(v); if (!v) { reset newListName, listMode, criteriaPanel, criteriaGaming, criteriaSegment, savingList } }` | ✅ (fixed in phase 4) |

### lines/page.tsx

| Modal | onOpenChange | State Reset |
|-------|------------|-------------|
| QR modal | `open => { if (!open) closeQr() }` | ✅ `closeQr()` resets qrLine, qrState, qrBase64, qrError, globalKey, canCreate, stops poll |

### warmup/page.tsx

| Modal | onOpenChange | State Reset |
|-------|------------|-------------|
| Add warmup | `open => { if (!open) setShowAdd(false) }` | ❌ Does NOT reset addName, addPhone, addInstance, addDays, addLimit, addError. Next open shows stale values. |
| Migration confirm | `open => { if (!open) { setMigratingId(null); setMigrateError('') } }` | ✅ |
| QR modal | `open => { if (!open) closeQr() }` | ✅ |
| Logs modal | `open => { if (!open) setLogsFor(null) }` | ✅ (logs array persists but is overwritten on next open) |

**Found gap:** `warmup/page.tsx` Add modal — stale form data on re-open. `openAdd()` function (line 92-95) resets the fields, but only when the "Agregar línea" button is clicked. If the modal is dismissed by ESC/backdrop and then opened again via the button, `openAdd()` is called and state is reset ✅. If opened by other means (e.g., programmatically), it might not be. Low risk in current flow.

---

## Component Imports

No unused component imports found in page files. All imported components (`Card`, `CardContent`, `Button`, `Input`, `Dialog`, `Select`, `Badge`, `Textarea`) are used in their respective pages.

`@supabase/supabase-js` is in `package.json` but not imported anywhere in the frontend source — **unused dependency**.
