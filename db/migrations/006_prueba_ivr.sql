-- 006: "Probar llamada" del IVR y momento en que arranca el mensaje (2026-11-03).
--   - llamadas.origen 'prueba': desde la sección IVR se llama a un número (ej. el celular de quien
--     prueba) con el mismo flujo de la campaña: AMD, audio, teclas y espera. No reparte avisos ni
--     toca contactos, y se guarda sin campaña (campana_id NULL) para no contar en los reportes ni
--     en las estadísticas de la campaña.
--   - llamadas.audio_inicio_en: cuándo empezó el mensaje. Desde que atiende hasta ahí es lo que
--     el cliente escucha en silencio (la detección de contestador).

ALTER TABLE llamadas DROP CONSTRAINT llamadas_origen_check;
ALTER TABLE llamadas ADD CONSTRAINT llamadas_origen_check CHECK (origen IN ('discador', 'manual', 'ivr', 'prueba'));

ALTER TABLE llamadas ADD COLUMN audio_inicio_en TIMESTAMPTZ;
