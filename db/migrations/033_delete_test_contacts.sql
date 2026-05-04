-- Migration 033: Eliminar contactos de prueba
-- Elimina los contactos Nico (+5492235042625) y Luchi (+5492915738277)
-- que fueron creados durante las pruebas iniciales de la plataforma.
-- Las tablas relacionadas tienen ON DELETE CASCADE / SET NULL, por lo que
-- no se requieren pasos previos.

DELETE FROM contacts
WHERE phone_number IN ('+5492235042625', '+5492915738277');
