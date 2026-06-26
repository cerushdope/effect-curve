"""The Repository interface — THE SWAP POINT.

Phase 1: `DummyRepository` (in-code archetypes).
Phase 2: `SqlRepository` (MySQL), SAME interface, nothing upstream changes.

Never let storage details (SQL, files, HTTP) leak above this seam.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional

from app.models import Substance, SubstanceSummary


class Repository(ABC):
    @abstractmethod
    def search(self, q: str) -> list[SubstanceSummary]:
        """Autocomplete over name + aliases. Empty query may return all/top-N."""
        ...

    @abstractmethod
    def get_substance(self, substance_id: str) -> Optional[Substance]:
        """Full record, or None if unknown."""
        ...
