import json
from pathlib import Path

import openpyxl


SOURCE_DIR = Path(r"D:\projects_D\cours_info_project\Mes classes")
OUTPUT = Path(__file__).resolve().parents[1] / "dist" / "seed-data.js"
FILES = [
    "export_notesCC_TCLSHF-1_0030.xlsx",
    "export_notesCC_TCLSHF-2_0030.xlsx",
    "export_notesCC_TCLSHF-3_0030.xlsx",
    "export_notesCC_TCLSHF-4_0030.xlsx",
    "export_notesCC_TCSF-7_0030.xlsx",
]


def clean(value):
    return value.strip() if isinstance(value, str) else value


classes = []
for filename in FILES:
    sheet = openpyxl.load_workbook(SOURCE_DIR / filename, data_only=True)["NotesCC"]
    students = []
    for row in range(18, sheet.max_row + 1):
        internal_id = sheet.cell(row, 2).value
        name = sheet.cell(row, 4).value
        if internal_id and name:
            students.append(
                {
                    "id": str(internal_id),
                    "massar": clean(sheet.cell(row, 3).value),
                    "name": clean(name),
                    "birthDate": clean(sheet.cell(row, 6).value),
                }
            )

    classes.append(
        {
            "id": clean(sheet["I9"].value).lower(),
            "name": clean(sheet["I9"].value),
            "level": clean(sheet["D9"].value),
            "year": clean(sheet["D13"].value),
            "subject": clean(sheet["O11"].value).title(),
            "source": filename,
            "students": students,
            "controls": [],
            "sessions": [],
        }
    )

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.write_text(
    "window.SEED_CLASSES = " + json.dumps(classes, ensure_ascii=False, indent=2) + ";\n",
    encoding="utf-8",
)
print(json.dumps({"output": str(OUTPUT), "classes": len(classes), "students": sum(len(c["students"]) for c in classes)}))
