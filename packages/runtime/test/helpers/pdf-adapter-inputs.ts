// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Newly authored synthetic extracts for portable PDF evidence behavior. */
export const PDF_TEST_INPUTS = Object.freeze({
  text: "SYNTHETIC PDF EXTRACT — Local receipt\nPlease retain the local receipt until filing is complete.\nSave the date and item description on separate lines.\n",
  pageTwoText:
    "SYNTHETIC EXTRACT — Receipt notes page 2\nFile the optional annotation beside the original receipt.\n",
  mainId: "input-receipt-example",
  pageTwoId: "input-receipt-notes",
  mainTitle: "Local receipt example",
  pageTwoTitle: "Receipt notes example",
  mainLogicalName: "inputs/receipt.pdf.txt",
  pageTwoLogicalName: "inputs/receipt-notes.extract.txt",
  citableFact: "retain the local receipt",
  revocableTitle: "Replaceable receipt",
  invalidParentName: "../private/receipt.pdf.txt",
});
