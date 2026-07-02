#!/usr/bin/env python3

import argparse
import contextlib
import json
import sys
from pathlib import Path


def serialize_story(story):
    role = getattr(getattr(story, "role", None), "functional_role", None)
    means = getattr(getattr(story, "means", None), "main_object", None)
    return {
        "number": story.number,
        "text": story.text,
        "role": {
            "name": str(getattr(role, "main", "") or ""),
            "compound": [str(token) for token in list(getattr(role, "compound", []) or [])]
        },
        "means": {
            "mainObject": str(getattr(means, "main", "") or ""),
            "compound": [str(token) for token in list(getattr(means, "compound", []) or [])]
        },
        "json": story.toJSON()
    }


def serialize_class(klass):
    return {
        "name": klass.name,
        "parent": klass.parent,
        "isRole": bool(getattr(klass, "is_role", False)),
        "stories": list(getattr(klass, "stories", []) or [])
    }


def serialize_relationship(relationship):
    return {
        "name": relationship.name,
        "domain": relationship.domain,
        "range": relationship.range,
        "stories": list(getattr(relationship, "stories", []) or [])
    }


def summarize_terms(matrix):
    if matrix is None:
        return []

    try:
        ranked = matrix["sum"].sort_values(ascending=False)
        out = []
        for term, weight in ranked.items():
            if len(out) >= 20:
                break
            text = str(term or "").strip()
            if not text:
                continue
            out.append({"term": text, "weight": float(weight)})
        return out
    except Exception:
        return []


def main():
    parser = argparse.ArgumentParser(description="Run Visual Narrator and emit structured JSON.")
    parser.add_argument("--input", required=True, help="Path to user-stories.txt")
    parser.add_argument("--system-name", default="System", help="System name for VN")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    vn_root = repo_root / "visual-narrator"
    sys.path.insert(0, str(vn_root))

    from vn.io import Reader
    from vn.vn import VisualNarrator

    input_path = Path(args.input).resolve()

    with contextlib.redirect_stdout(sys.stderr):
        visual_narrator = VisualNarrator()
        stories = Reader.parse(str(input_path))
        us_instances, failed_stories = visual_narrator._mine_stories(
            stories,
            args.system_name,
            log_time=visual_narrator.time
        )
        matrix, _count_matrix = visual_narrator._get_matrix(us_instances, log_time=visual_narrator.time)
        output_ontology, _output_prolog, _onto_per_role = visual_narrator._get_gen(
            us_instances,
            matrix,
            args.system_name,
            False,
            log_time=visual_narrator.time
        )

    inferred_roles = sorted(
        {
            str(getattr(getattr(story, "role", None).functional_role, "main", "") or "").strip()
            for story in us_instances
            if getattr(getattr(story, "role", None), "functional_role", None) is not None
            and str(getattr(getattr(story, "role", None).functional_role, "main", "") or "").strip()
        }
    )

    result = {
        "ok": True,
        "inputPath": str(input_path),
        "systemName": args.system_name,
        "ontology": str(output_ontology),
        "stories": [serialize_story(story) for story in us_instances],
        "failedStories": failed_stories,
        "classes": [serialize_class(klass) for klass in output_ontology.classes],
        "relationships": [serialize_relationship(rel) for rel in output_ontology.relationships],
        "inferredRoles": inferred_roles,
        "keyNouns": summarize_terms(matrix),
        "stats": {
            "successCount": len(us_instances),
            "failedCount": len(failed_stories)
        }
    }

    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
