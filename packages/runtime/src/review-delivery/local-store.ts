// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  FileScmDeliveryReceiptStore,
  type FileScmDeliveryReceiptStoreOptions,
} from "../delivery/receipt-store.js";
import {
  resolveDocsFabPublicationRoots,
  type DocsFabPublicationRoots,
} from "../config/host-paths.js";

/** The review dialect uses the existing private receipt journal and lease. */
export function createLocalReviewDeliveryStore(
  roots: DocsFabPublicationRoots = resolveDocsFabPublicationRoots(),
  options: FileScmDeliveryReceiptStoreOptions = {},
): FileScmDeliveryReceiptStore {
  return new FileScmDeliveryReceiptStore(roots.receiptRoot, options);
}
