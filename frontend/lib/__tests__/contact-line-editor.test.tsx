import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { EditableCell } from '@/components/data-display/DataTable/EditableCell'

afterEach(cleanup)
const options = Array.from({length:100},(_,i)=>({value:String(i+1),label:`Línea ${i+1}`}))

it.each(['pointer','keyboard'])('opens every line on the first %s interaction and retains the chosen value', interaction => {
  const save=vi.fn()
  function Editor() {
    const [value,setValue]=useState('8')
    return <EditableCell ariaLabel="Editar línea" value={value} options={options} lazyOptions
      onChange={next=>{setValue(next);save(next)}} />
  }
  render(<Editor />)
  const select=screen.getByRole('combobox',{name:'Editar línea'})
  expect(select).toHaveValue('8')
  expect(select.querySelectorAll('option')).toHaveLength(2)
  if(interaction==='pointer') fireEvent.pointerDown(select)
  else {fireEvent.focus(select);fireEvent.keyDown(select,{key:'ArrowDown'})}
  expect(select.querySelectorAll('option')).toHaveLength(101)
  expect(save).not.toHaveBeenCalled()
  fireEvent.change(select,{target:{value:'100'}})
  fireEvent.blur(select)
  expect(save).toHaveBeenCalledExactlyOnceWith('100')
  expect(select).toHaveValue('100')
  expect(select).toHaveTextContent('Línea 100')
  expect(select.querySelectorAll('option')).toHaveLength(2)
})

it('leaves the compact editors unchanged and preserves click isolation from the row', () => {
  const rowClick=vi.fn()
  render(<div onClick={rowClick}><EditableCell value="8" options={options} onChange={()=>{}} /></div>)
  const select=screen.getByRole('combobox')
  expect(select.querySelectorAll('option')).toHaveLength(101)
  fireEvent.click(select)
  expect(rowClick).not.toHaveBeenCalled()
})
