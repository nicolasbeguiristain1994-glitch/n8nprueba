import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ContactLineFilter } from '../ContactLineFilter'

afterEach(cleanup)
function Harness() {
  const [lines, setLines] = useState<string[]>([])
  return <ContactLineFilter value={lines} onChange={setLines} />
}
it('keeps multiple choices selected while searching, deselects one and clears all', async () => {
  const user = userEvent.setup()
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Filtrar por líneas: Todas las líneas' }))
  await user.click(await screen.findByRole('checkbox', { name: 'Línea 2', exact: true }))
  await user.click(screen.getByRole('checkbox', { name: 'Línea 7', exact: true }))
  expect(screen.getByRole('button', { name: 'Filtrar por líneas: 2 líneas' })).toHaveAttribute('aria-expanded', 'true')
  fireEvent.change(screen.getByLabelText('Buscar línea'), { target: { value: 'linea 100' } })
  expect(screen.queryByRole('checkbox', { name: 'Línea 2', exact: true })).not.toBeInTheDocument()
  await user.click(screen.getByRole('checkbox', { name: 'Línea 100', exact: true }))
  fireEvent.change(screen.getByLabelText('Buscar línea'), { target: { value: '' } })
  expect(screen.getByRole('checkbox', { name: 'Línea 2', exact: true })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Línea 7', exact: true })).toBeChecked()
  await user.click(screen.getByRole('checkbox', { name: 'Línea 7', exact: true }))
  expect(screen.getByRole('button', { name: 'Filtrar por líneas: 2 líneas' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Todas las líneas', exact: true }))
  expect(screen.getByRole('checkbox', { name: 'Línea 2', exact: true })).not.toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Línea 100', exact: true })).not.toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'Listo' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Filtrar por líneas: Todas las líneas' })).toHaveAttribute('aria-expanded', 'false'))
})
it('closes on Escape and restores focus to the trigger', async () => {
  render(<Harness />)
  const trigger = screen.getByRole('button', { name: 'Filtrar por líneas: Todas las líneas' })
  fireEvent.click(trigger)
  const search = await screen.findByLabelText('Buscar línea')
  search.focus()
  fireEvent.keyDown(search, { key: 'Escape' })
  await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'))
  await waitFor(() => expect(trigger).toHaveFocus())
})
