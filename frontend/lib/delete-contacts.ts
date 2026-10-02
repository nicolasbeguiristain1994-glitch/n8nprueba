/** Delete in small batches so a large selection cannot exhaust the API/DB pool. */
export async function deleteContacts(ids: string[]) {
  const uniqueIds = [...new Set(ids)]
  const deleted: string[] = []
  const failed: { id: string; error: string }[] = []
  for (let offset = 0; offset < uniqueIds.length; offset += 3) {
    await Promise.all(uniqueIds.slice(offset, offset + 3).map(async id => {
      try {
        const response = await fetch(`/api/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' })
        // A retry after a lost response may find that the contact was already deleted.
        if (response.ok || response.status === 404) {
          deleted.push(id)
          return
        }
        const data = await response.json().catch(() => null)
        const message = response.status === 401
          ? 'Tu sesión venció. Volvé a iniciar sesión.'
          : response.status === 403
            ? 'No tenés permiso para eliminar contactos.'
            : typeof data?.error === 'string' ? data.error : `Error del servidor (${response.status}).`
        failed.push({ id, error: message })
      } catch {
        failed.push({ id, error: 'No se pudo conectar con el servidor. Volvé a intentar.' })
      }
    }))
  }
  return { deleted, failed }
}
