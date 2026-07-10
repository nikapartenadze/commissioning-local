#!/usr/bin/env python3
"""
Patch libplctag's ab_server (v2.6.16) to serve our field tag names.

Why: the stock ab_server only allows [A-Za-z0-9_] tag names and matches a
SINGLE symbolic segment from the CIP request path. Our field tags are
module-addressed ("UL21_3_VFD:I.In_0") and UDT members
("CBT_UL21_3_VFD.CTRL.CMD.Valid_Map") — libplctag clients encode those as
MULTIPLE symbolic segments. Two changes:

  1. main.c parse_cip_tag(): the name/type separator is the LAST ':' in the
     definition string, so names may contain ':' and '.'.
     ("--tag=UL21_3_VFD:I.In_0:SINT[1]")
  2. cip.c parse_tag_path(): consume ALL consecutive 0x91 symbolic segments,
     join them with '.', and match the full flat name against the tag list.

Anchor-based replacement: the build FAILS LOUDLY if upstream drifts and an
anchor stops matching — never silently builds an unpatched server.
"""
import pathlib
import sys

SRC = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")


def patch(path: pathlib.Path, old: str, new: str) -> None:
    text = path.read_text()
    if old not in text:
        sys.exit(f"PATCH ANCHOR NOT FOUND in {path}:\n---\n{old[:300]}\n---")
    if text.count(old) != 1:
        sys.exit(f"PATCH ANCHOR AMBIGUOUS ({text.count(old)} hits) in {path}")
    path.write_text(text.replace(old, new))
    print(f"patched: {path}")


# ── 1. main.c — allow ':' and '.' in tag names (split on LAST colon) ────────
patch(
    SRC / "main.c",
    """    /* first match the name. */
    start = 0;
    len = strspn(tag_str + start, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_");
    if(!len) {
        // NOLINTNEXTLINE
        fprintf(stderr, "Unable to parse tag definition string, cannot find tag name in \\"%s\\"!\\n", tag_str);
        usage();
    } else {
        /* copy the string. */
        for(size_t i = 0; i < len && i < (size_t)200; i++) { tag_name[i] = tag_str[start + i]; }

        start += len;
    }
""",
    """    /* BATTLE PATCH: field tag names contain ':' and '.' (module tags like
       "UL21_3_VFD:I.In_0", UDT members like "CBT_X.CTRL.CMD.Valid_Map").
       The name/type separator is therefore the LAST colon in the string. */
    start = 0;
    {
        const char *last_colon = strrchr(tag_str, ':');
        if(!last_colon || last_colon == tag_str) {
            // NOLINTNEXTLINE
            fprintf(stderr, "Unable to parse tag definition string, cannot find tag name in \\"%s\\"!\\n", tag_str);
            usage();
        }
        len = (size_t)(last_colon - tag_str);
        for(size_t i = 0; i < len && i < (size_t)199; i++) { tag_name[i] = tag_str[start + i]; }
        start += len;
    }
""",
)

# ── 2. cip.c — multi-segment symbolic path → full dotted name match ────────
patch(
    SRC / "cip.c",
    """    /* Get the segment marker */
    segment_marker = slice_get_uint8(tag_path, offset);
    offset++;
    if(segment_marker != CIP_SYMBOLIC_SEGMENT_MARKER) {
        log_info("Expected symbolic segment marker but found %x!", segment_marker);
        return false;
    }

    /* Get the name length */
    name_len = slice_get_uint8(tag_path, offset);
    offset++;
    if(name_len + offset > slice_len(tag_path)) {
        log_info("Name length %d exceeds remaining tag path length %d!", name_len, slice_len(tag_path) - offset);
        return false;
    }

    /* Extract the tag name slice */
    tag_name_slice = slice_from_slice(tag_path, offset, name_len);
    offset += name_len;

    /* Align to 16-bit boundary if necessary */
    if(offset % 2 != 0) { offset++; }

    /* find the tag */
    *tag = plc->tags;

    while(*tag) {
        if(slice_match_string_exact(tag_name_slice, (*tag)->name)) {
            log_info("Found tag %s", (*tag)->name);
            break;
        }

        (*tag) = (*tag)->next_tag;
    }

    if(!*tag) {
        log_info("Tag %.*s not found!", slice_len(tag_name_slice), (const char *)(tag_name_slice.data));
        return false;
    }
""",
    """    /* BATTLE PATCH: libplctag clients encode "Device:I.Member" and
       "Tag.Member.Sub" as MULTIPLE consecutive 0x91 symbolic segments.
       Consume them all, join with '.', and match the full flat name.
       (Stock code matched only the FIRST segment.) */
    char full_name[256] = {0};
    size_t full_name_len = 0;

    while(offset < slice_len(tag_path)) {
        segment_marker = slice_get_uint8(tag_path, offset);
        if(segment_marker != CIP_SYMBOLIC_SEGMENT_MARKER) { break; /* numeric indexes follow */ }
        offset++;

        name_len = slice_get_uint8(tag_path, offset);
        offset++;
        if(name_len + offset > slice_len(tag_path)) {
            log_info("Name length %d exceeds remaining tag path length %d!", name_len, slice_len(tag_path) - offset);
            return false;
        }
        if(full_name_len + (size_t)name_len + 2 > sizeof(full_name)) {
            log_info("Joined symbolic path too long!");
            return false;
        }
        if(full_name_len > 0) { full_name[full_name_len++] = '.'; }
        for(uint8_t i = 0; i < name_len; i++) {
            full_name[full_name_len++] = (char)slice_get_uint8(tag_path, offset + (size_t)i);
        }
        offset += name_len;

        /* Align to 16-bit boundary if necessary */
        if(offset % 2 != 0) { offset++; }
    }

    if(full_name_len == 0) {
        log_info("Expected symbolic segment marker but found none!");
        return false;
    }

    /* silence unused-variable warning for the stock slice */
    (void)tag_name_slice;

    /* find the tag by full dotted name */
    *tag = plc->tags;

    while(*tag) {
        if(strcmp(full_name, (*tag)->name) == 0) {
            log_info("Found tag %s", (*tag)->name);
            break;
        }

        (*tag) = (*tag)->next_tag;
    }

    if(!*tag) {
        log_info("Tag %s not found!", full_name);
        return false;
    }
""",
)

# ── 3. cip.c — serve the CIP Identity Object (Class 0x01, Instance 1) ───────
# The field tool's firmware-compliance scan reads every controller's Identity
# via a @raw Get_Attributes_All (service 0x01). Stock ab_server answers
# CIP_ERR_UNSUPPORTED → the tool reports the controller "unreachable" and the
# firmware feature is untestable on the rig. Serve a canned 1756-L85E identity
# (rev 33.11) so firmware scenarios can flip compliant/non_compliant purely by
# changing the cloud-stage baseline data.
patch(
    SRC / "cip.c",
    """slice_s cip_dispatch_unconnected_request(slice_s input, slice_s output, plc_s *plc) {
""",
    """/* BATTLE PATCH: canned CIP Identity Object (Class 0x01, Instance 1).
   Vendor 1 (Rockwell), type 14 (PLC), product code 168 (1756-L85E),
   firmware rev 33.11. Read-only Get_Attributes_All; anything else on the
   Identity class still returns unsupported. */
static slice_s handle_identity_request(uint8_t cip_service, slice_s cip_service_path, slice_s output) {
    size_t offset = 0;
    const char *name = "1756-L85E BATTLE-SIM/B";
    size_t name_len = strlen(name);

    /* only [0x20 0x01 0x24 0x01] — class 0x01, instance 1, 8-bit segments */
    if(slice_len(cip_service_path) != 4 || slice_get_uint8(cip_service_path, 0) != 0x20
       || slice_get_uint8(cip_service_path, 1) != 0x01 || slice_get_uint8(cip_service_path, 2) != 0x24
       || slice_get_uint8(cip_service_path, 3) != 0x01) {
        return make_cip_log_error(output, cip_service, CIP_ERR_UNSUPPORTED, false, 0);
    }

    slice_set_uint8(output, offset, cip_service | CIP_DONE);
    offset++;
    slice_set_uint8(output, offset, 0); /* reserved */
    offset++;
    slice_set_uint8(output, offset, 0); /* general status: OK */
    offset++;
    slice_set_uint8(output, offset, 0); /* no extended status */
    offset++;
    slice_set_uint16_le(output, offset, 1); /* Vendor ID: Rockwell */
    offset += 2;
    slice_set_uint16_le(output, offset, 14); /* Device Type: PLC */
    offset += 2;
    slice_set_uint16_le(output, offset, 168); /* Product Code */
    offset += 2;
    slice_set_uint8(output, offset, 33); /* Major firmware revision */
    offset++;
    slice_set_uint8(output, offset, 11); /* Minor firmware revision */
    offset++;
    slice_set_uint16_le(output, offset, 0x0060); /* Status */
    offset += 2;
    slice_set_uint32_le(output, offset, 0x00B47713UL); /* Serial */
    offset += 4;
    slice_set_uint8(output, offset, (uint8_t)name_len);
    offset++;
    for(size_t i = 0; i < name_len; i++) {
        slice_set_uint8(output, offset, (uint8_t)name[i]);
        offset++;
    }

    return slice_from_slice(output, 0, offset);
}


slice_s cip_dispatch_unconnected_request(slice_s input, slice_s output, plc_s *plc) {
""",
)

patch(
    SRC / "cip.c",
    """        case CIP_SRV_PCCC_EXECUTE: return dispatch_pccc_request(input, output, plc); break;
""",
    """        case CIP_SRV_PCCC_EXECUTE: return dispatch_pccc_request(input, output, plc); break;

        /* BATTLE PATCH: Get_Attributes_All on the Identity Object */
        case 0x01: return handle_identity_request(cip_service, cip_service_path, output); break;
""",
)

patch(
    SRC / "cip.c",
    """        case CIP_SRV_MULTI: return handle_multi_request(cip_service, cip_service_path, cip_service_payload, output, plc); break;
""",
    """        case CIP_SRV_MULTI: return handle_multi_request(cip_service, cip_service_path, cip_service_payload, output, plc); break;

        /* BATTLE PATCH: Get_Attributes_All on the Identity Object */
        case 0x01: return handle_identity_request(cip_service, cip_service_path, output); break;
""",
)

# strcmp needs string.h — ensure the include exists in cip.c (idempotent).
cip = SRC / "cip.c"
text = cip.read_text()
if "#include <string.h>" not in text:
    first_include = text.index("#include")
    text = text[:first_include] + "#include <string.h>\n" + text[first_include:]
    cip.write_text(text)
    print("patched: cip.c (+ <string.h>)")

print("ab_server patch complete")
