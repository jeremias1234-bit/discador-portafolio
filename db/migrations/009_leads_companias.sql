-- 009: compañías que generan lead (2026-11-08).
--   El bot atiende clientes de Claro, Personal, Tuenti y Movistar, pero solo los de Claro son
--   leads (portabilidad y fibra). El Detector reconoce la compañía por la respuesta al primer menú
--   del bot o por su mensaje "Veo que eres cliente de …" y solo manda el lead si está en esta lista.
--   Si no la puede reconocer, no lo manda (queda anotado en el registro del Detector).
INSERT INTO configuracion (clave, valor) VALUES ('leads.companias', '["Claro"]');
