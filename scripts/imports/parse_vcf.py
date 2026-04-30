"""
parse_vcf.py — Parser de archivos vCard 3.0 para múltiples contactos.

Estrategia:
  1. Leer el archivo completo en memoria (UTF-8).
  2. Limpiar ruido previo al primer BEGIN:VCARD (ej: "vcfBEGIN:VCARD").
  3. Desplegar líneas plegadas ("folded lines": continuación con espacio/tab).
  4. Segmentar el stream en bloques BEGIN:VCARD … END:VCARD.
  5. Parsear cada bloque extrayendo los campos relevantes.
  6. Devolver lista de dicts normalizados.

Decisiones ante ambigüedades del formato:
  - Si hay múltiples FN en un mismo VCARD, se usa el primero.
  - TEL acepta cualquier sufijo de parámetros (TYPE=CELL, TYPE=WORK, etc.).
  - N se parte por ";" y se toma índice 0 → apellido, índice 1 → nombre.
  - CATEGORIES separadas por coma dentro del valor.
  - Campos vacíos o ausentes se mapean a "" o [] según el tipo.
  - Líneas que no contienen ":" se ignoran silenciosamente.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from pathlib import Path


# ── Dataclass ────────────────────────────────────────────────────────────────

@dataclass
class Contact:
    full_name:  str        = ""
    first_name: str        = ""
    last_name:  str        = ""
    phones:     list[str]  = field(default_factory=list)
    org:        str        = ""
    categories: list[str]  = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


# ── Helpers privados ─────────────────────────────────────────────────────────

def _unfold(lines: list[str]) -> list[str]:
    """
    Despliega líneas plegadas vCard.
    Una línea que empieza con espacio o tab es continuación de la anterior.
    """
    unfolded: list[str] = []
    for line in lines:
        if line and line[0] in (" ", "\t"):
            if unfolded:
                unfolded[-1] += line[1:]  # quita el carácter de plegado
            # si no hay línea previa, descartamos (mal formado)
        else:
            unfolded.append(line)
    return unfolded


def _split_into_blocks(text: str) -> list[list[str]]:
    """
    Segmenta el texto completo en bloques de líneas, uno por contacto.
    Maneja ruido antes de BEGIN:VCARD (ej: "vcfBEGIN:VCARD").

    Decisión: si una línea contiene BEGIN:VCARD en cualquier posición,
    se la trata como inicio de bloque nuevo.
    """
    # Normalizar saltos de línea
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    raw_lines = text.split("\n")

    blocks: list[list[str]] = []
    current: list[str] | None = None

    for raw in raw_lines:
        # Detectar inicio de VCARD incluso con ruido prefijo (vcfBEGIN:VCARD)
        if "BEGIN:VCARD" in raw:
            current = ["BEGIN:VCARD"]
            continue

        if "END:VCARD" in raw:
            if current is not None:
                current.append("END:VCARD")
                blocks.append(current)
                current = None
            continue

        if current is not None:
            current.append(raw)

    return blocks


def _parse_field(line: str) -> tuple[str, str]:
    """
    Divide una línea vCard en (nombre_campo, valor).
    El nombre puede llevar parámetros: TEL;TYPE=CELL → clave base = "TEL".
    Devuelve ("", "") si la línea no tiene ":" o es encabezado/fin de bloque.
    """
    if ":" not in line:
        return "", ""
    key_part, _, value = line.partition(":")
    # La clave puede ser "TEL;TYPE=CELL;TYPE=VOICE" → nos queda solo "TEL"
    base_key = key_part.split(";")[0].strip().upper()
    return base_key, value.strip()


def _parse_n(value: str) -> tuple[str, str]:
    """
    Parsea el campo N: apellido;nombre;segundo_nombre;prefijo;sufijo
    Índice 0 → last_name, índice 1 → first_name.
    """
    parts = value.split(";")
    last  = parts[0].strip() if len(parts) > 0 else ""
    first = parts[1].strip() if len(parts) > 1 else ""
    return last, first


def _parse_categories(value: str) -> list[str]:
    """
    CATEGORIES puede ser una lista separada por comas.
    Filtra entradas vacías y normaliza espacios.
    """
    return [c.strip() for c in value.split(",") if c.strip()]


def _parse_block(lines: list[str]) -> Contact:
    """Convierte un bloque de líneas (un VCARD) en un objeto Contact."""
    contact = Contact()
    unfolded = _unfold(lines)

    for line in unfolded:
        key, value = _parse_field(line)
        if not key or not value:
            continue

        if key == "FN" and not contact.full_name:
            contact.full_name = value

        elif key == "N" and not contact.first_name and not contact.last_name:
            contact.last_name, contact.first_name = _parse_n(value)

        elif key == "TEL":
            normalized = _normalize_phone(value)
            if normalized:
                contact.phones.append(normalized)

        elif key == "ORG" and not contact.org:
            contact.org = value

        elif key == "CATEGORIES":
            contact.categories.extend(_parse_categories(value))

        # Campos desconocidos → ignorados silenciosamente

    return contact


# Patrón para normalización básica de teléfonos
_PHONE_CLEAN_RE = re.compile(r"[\s\-().]+")


def _normalize_phone(raw: str) -> str | None:
    """
    Limpia el teléfono eliminando espacios, guiones y paréntesis.
    No descarta números que ya vienen en formato E.164.
    Devuelve None si queda vacío tras la limpieza.
    """
    cleaned = _PHONE_CLEAN_RE.sub("", raw).strip()
    return cleaned if cleaned else None


# ── API pública ──────────────────────────────────────────────────────────────

def parse_vcf(file_path: str | Path) -> list[dict]:
    """
    Lee un archivo .vcf con uno o múltiples contactos y devuelve
    una lista de diccionarios con los campos normalizados.

    Args:
        file_path: Ruta al archivo .vcf (str o Path).

    Returns:
        Lista de dicts con claves:
          full_name, first_name, last_name, phones, org, categories.
    """
    path = Path(file_path)
    text = path.read_text(encoding="utf-8", errors="replace")

    blocks = _split_into_blocks(text)
    contacts: list[dict] = []

    for block in blocks:
        contact = _parse_block(block)
        contacts.append(contact.to_dict())

    return contacts


# ── Ejemplo de uso ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    import json

    if len(sys.argv) < 2:
        print("Uso: python parse_vcf.py archivo.vcf")
        sys.exit(1)

    results = parse_vcf(sys.argv[1])
    print(json.dumps(results, ensure_ascii=False, indent=2))
    print(f"\n→ {len(results)} contacto(s) parseado(s).")
