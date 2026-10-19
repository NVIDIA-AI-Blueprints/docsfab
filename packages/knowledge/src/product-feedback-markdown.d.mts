// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
export interface ProductFeedbackMarkdownRange { readonly start:number; readonly end:number; }
export interface ProductFeedbackMarkdownSection extends ProductFeedbackMarkdownRange {
  readonly heading:string;
  readonly headingLevel:1|2;
  readonly rows:readonly {readonly raw:string;readonly text:string;readonly start:number;readonly end:number;readonly kind:string}[];
}
export function assertProductFeedbackParagraph(value:unknown):string;
export function selectProductFeedbackMarkdownSection(content:string,heading:string|null):ProductFeedbackMarkdownSection;
export function productFeedbackParagraphRange(content:string,heading:string|null,beforeText:string):ProductFeedbackMarkdownRange;
export function productFeedbackControlledRange(content:string,heading:string|null,claimId:string):ProductFeedbackMarkdownRange & {
  readonly heading:string;readonly headingLevel:1|2;
};
export function productFeedbackClaimSpanRange(content:string,heading:string|null,paragraph:string,
 selection:{readonly kind:'claim-span';readonly startByte:number;readonly endByte:number;readonly beforeText:string},claimId?:string):ProductFeedbackMarkdownRange & {
 readonly prefix:string;readonly suffix:string;readonly paragraphStart:number;readonly paragraphEnd:number;
};
