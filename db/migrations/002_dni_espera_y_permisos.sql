-- 002: DNI en los contactos, objetivo de espera entre llamadas y permisos por defecto (2026-10-27).
--   - Formato de las bases: teléfono | nombre | DNI | el resto de las columnas.
--   - En predictivo la idea es que el vendedor espere entre 5 y 60 s entre llamadas (es una guía:
--     el monitor la marca, no frena nada).
--   - El supervisor escucha llamadas en vivo por defecto; el vendedor escucha sus propias grabaciones.

ALTER TABLE leads ADD COLUMN dni TEXT;

INSERT INTO configuracion (clave, valor) VALUES
  ('ritmo.espera_objetivo_min_seg', '5'),
  ('ritmo.espera_objetivo_max_seg', '60');

INSERT INTO permisos (codigo, area, descripcion, orden) VALUES
  ('grabaciones.propias', 'Grabaciones', 'Escuchar sus propias llamadas (vendedor)', 92);

INSERT INTO rol_permisos (rol, permiso) VALUES
  ('supervisor', 'supervision.escuchar'),
  ('vendedor', 'grabaciones.propias'),
  ('admin', 'grabaciones.propias');
