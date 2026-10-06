import React from 'react'
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BroadcastFilter } from '@/components/contacts/BroadcastFilter'
import { EMPTY_BROADCAST } from '@/lib/broadcast-range'
afterEach(cleanup)
it('defaults to excluding the last seven days and only applies explicitly',()=>{
  const change=vi.fn();render(<BroadcastFilter value={EMPTY_BROADCAST} onChange={change}/>);
  fireEvent.click(screen.getByRole('button',{name:'Difusión'}));
  expect(screen.getByLabelText('Cantidad de días')).toHaveValue(7);
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Aplicar difusión'}));
  expect(change).toHaveBeenCalledWith({...EMPTY_BROADCAST,mode:'not_sent'});
})
it('validates date ranges and clears the active filter',()=>{
  const change=vi.fn();render(<BroadcastFilter value={{...EMPTY_BROADCAST,mode:'sent'}} onChange={change}/>);
  fireEvent.click(screen.getByRole('button',{name:'Difundidos: últimos 7 días'}));
  fireEvent.change(screen.getByLabelText('Período'),{target:{value:'dates'}});
  expect(screen.getByRole('button',{name:'Aplicar difusión'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Desde'),{target:{value:'2026-10-06'}});
  fireEvent.change(screen.getByLabelText('Hasta'),{target:{value:'2026-10-06'}});
  expect(screen.getByRole('button',{name:'Aplicar difusión'})).toBeEnabled();
  fireEvent.click(screen.getByRole('button',{name:'Limpiar difusión'}));expect(change).toHaveBeenCalledWith(EMPTY_BROADCAST);
})
