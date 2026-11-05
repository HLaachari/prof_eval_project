#!/usr/bin/env python3
"""Synchronise les effectifs Excel avec l'API locale sans supprimer l'historique."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from datetime import date, datetime
from pathlib import Path

import openpyxl


DEFAULT_FILES = [
    Path(r"C:\Users\abdel\Downloads\export_notesCC_TCLSHF-1_0030 (1).xlsx"),
    Path(r"C:\Users\abdel\Downloads\export_notesCC_TCLSHF-2_0030 (1).xlsx"),
    Path(r"C:\Users\abdel\Downloads\export_notesCC_TCLSHF-3_0030 (1).xlsx"),
    Path(r"C:\Users\abdel\Downloads\export_notesCC_TCLSHF-4_0030 (1).xlsx"),
    Path(r"C:\Users\abdel\Downloads\export_notesCC_TCSF-7_0030 (1).xlsx"),
]


def text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def birth_date(value) -> str:
    if isinstance(value, (datetime, date)):
        return value.strftime("%d/%m/%Y")
    raw = text(value)
    for pattern in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(raw, pattern).strftime("%d/%m/%Y")
        except ValueError:
            pass
    return raw


def read_roster(path: Path) -> tuple[str, list[dict]]:
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet = workbook["NotesCC"]
    class_name = text(sheet.cell(9, 9).value).upper()
    students = []
    for values in sheet.iter_rows(min_row=18, values_only=True):
        student_id = text(values[1] if len(values) > 1 else None)
        massar = text(values[2] if len(values) > 2 else None).upper()
        name = text(values[3] if len(values) > 3 else None)
        if not student_id or not massar or not name:
            continue
        students.append(
            {
                "excelId": student_id,
                "massar": massar,
                "name": name,
                "birthDate": birth_date(values[5] if len(values) > 5 else None),
                "orderNumber": len(students) + 1,
            }
        )
    workbook.close()
    if not class_name or not students:
        raise ValueError(f"Liste invalide ou vide : {path}")
    return class_name, students


def fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url) as response:
        return json.load(response)


def put_json(url: str, payload: dict) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def synchronize(classes: list[dict], rosters: dict[str, list[dict]], today: str) -> list[dict]:
    report = []
    classes_by_name = {text(item.get("name")).upper(): item for item in classes}
    for class_name, roster in rosters.items():
        class_item = classes_by_name.get(class_name)
        if not class_item:
            raise ValueError(f"Classe absente de l'application : {class_name}")
        existing = class_item.setdefault("students", [])
        by_massar = {text(student.get("massar")).upper(): student for student in existing}
        roster_codes = {row["massar"] for row in roster}
        added = []
        reactivated = []
        for row in roster:
            student = by_massar.get(row["massar"])
            if student:
                if student.get("active") is False:
                    reactivated.append(row["massar"])
                    student["activeSince"] = today
                student.update(
                    name=row["name"],
                    massar=row["massar"],
                    birthDate=row["birthDate"],
                    orderNumber=row["orderNumber"],
                    active=True,
                    inactiveSince="",
                )
            else:
                candidate_id = row["excelId"]
                used_ids = {text(item.get("id")) for item in existing}
                if candidate_id in used_ids:
                    candidate_id = f"{candidate_id}-{row['massar'].lower()}"
                student = {
                    "id": candidate_id,
                    "name": row["name"],
                    "massar": row["massar"],
                    "birthDate": row["birthDate"],
                    "grades": {},
                    "activityScore": "",
                    "participationScore": "",
                    "bonusPoints": 0,
                    "orderNumber": row["orderNumber"],
                    "active": True,
                    "activeSince": today,
                    "inactiveSince": "",
                }
                existing.append(student)
                by_massar[row["massar"]] = student
                added.append(row["massar"])
        departed = []
        for student in existing:
            code = text(student.get("massar")).upper()
            if code not in roster_codes:
                if student.get("active") is not False:
                    departed.append(code)
                student["active"] = False
                student["inactiveSince"] = student.get("inactiveSince") or today
        report.append(
            {
                "class": class_name,
                "active": len(roster),
                "added": added,
                "reactivated": reactivated,
                "departed": departed,
                "preservedFormer": sum(1 for student in existing if student.get("active") is False),
            }
        )
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://127.0.0.1:4173/api/classes")
    parser.add_argument("--apply", action="store_true", help="Écrit le résultat dans la base locale.")
    parser.add_argument("--effective-date", default="2026-11-02", help="Date à partir de laquelle le nouvel effectif s'applique (AAAA-MM-JJ).")
    parser.add_argument("files", nargs="*", type=Path, default=DEFAULT_FILES)
    args = parser.parse_args()
    files = args.files or DEFAULT_FILES
    missing = [str(path) for path in files if not path.exists()]
    if missing:
        raise FileNotFoundError("Fichiers introuvables : " + ", ".join(missing))
    rosters = dict(read_roster(path) for path in files)
    payload = fetch_json(args.api)
    report = synchronize(payload["classes"], rosters, args.effective_date)
    if args.apply:
        put_json(args.api, {"classes": payload["classes"]})
    print(json.dumps({"mode": "apply" if args.apply else "dry-run", "report": report}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
