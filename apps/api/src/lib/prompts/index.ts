import { splitMessageIntoMultipleDealsDef } from './definitions/split_message_into_multiple_deals';
import { combineDealSummariesDef } from './definitions/combine_deal_summaries';
import { generateShortSummaryDef } from './definitions/generate_short_summary';
import { generateTeaserSummaryDef } from './definitions/generate_teaser_summary';
import { textMergeDef } from './definitions/text_merge';
import { aggregateLocationsDef } from './definitions/aggregate_locations';
import { aggregateThemesDef } from './definitions/aggregate_themes';
import { DefinitionArgs, PromptDefinition } from './definition';
import { execute } from './execute';
import { matchSearchResultDef } from './definitions/match_search_result';
import { identifyCompanyDef } from './definitions/identify_company';
import { identifyCompanySplittableDef } from './definitions/identify_company_splittable';
import { identifyEntityDef } from './definitions/identify_entity';
import { findRelevantUrlsDef } from './definitions/find_relevant_urls';
import { findRelevantPersonUrlsDef } from './definitions/find_relevant_person_urls';
import { identifyCompanyRelatedEntitiesDef } from './definitions/identify_company_related_entities';
import { parsePersonDisplayDef } from './definitions/parse_person_display_data';
import { identifyPersonRelatedEntitiesDef } from './definitions/identify_person_related_entities';
import { identifySourcesDef } from './definitions/identify_sources';
import { generateLabelsDef } from './definitions/generate_labels';
import { generateCompanySummaryDef } from './definitions/generate_company_summaries';
import { processWebsiteDef } from './definitions/process_website_content';
import { generatePersonSummaryDef } from './definitions/generate_person_summary';
import { getPitchDeckNameDef } from './definitions/get_pitch_deck_name';
import { matchFounderSearchDef } from './definitions/match_founder_search';
import { compressTextDef } from './definitions/compress_text';
import { identifyCompanyCompanyRelationsDef } from './definitions/identify_company_company_relations';
import { identifyCompanyPeopleRelationsDef } from './definitions/identify_company_people_relations';
import { classifyInputDef } from './definitions/classify_input';
import { classifyContextDef } from './definitions/classify_context';
import { identifyPeopleCompanyRelationsDef } from './definitions/identify_people_company_relations';
import { extractCompanyDetailsDef } from './definitions/extract_company_details';
import { extractPersonDetailsDef } from './definitions/extract_person_details';
import { matchEntitiesDef } from './definitions/match_entities';
import { fundraisingSoonDef } from './definitions/fundraising_soon';
import { isMultiDealMessageDef } from './definitions/is_multi_deal_message';
import { identifyEntityFromRequestDef } from './definitions/identify_entity_from_request';
import { parseTableFiltersDef } from './definitions/parse_table_filters';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getExecuteFn<T extends PromptDefinition<any, any>>(name: string, definition: T) {
  return async (
    args: DefinitionArgs<T['arguments']>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: Partial<PromptDefinition<any, any>>,
  ) => execute<T>(name, { ...definition, ...options }, args);
}

class Prompt {
  static aggregateLocations = getExecuteFn('AGGREGATE_LOCATIONS', aggregateLocationsDef);
  static aggregateThemes = getExecuteFn('AGGREGATE_THEMES', aggregateThemesDef);
  static classifyContext = getExecuteFn('CLASSIFY_CONTEXT', classifyContextDef);
  static classifyInput = getExecuteFn('CLASSIFY_INPUT', classifyInputDef);
  static combineDealSummaries = getExecuteFn('COMBINE_DEAL_SUMMARIES', combineDealSummariesDef);
  static extractCompanyDetails = getExecuteFn('EXTRACT_COMPANY_DETAILS', extractCompanyDetailsDef);
  static extractPersonDetails = getExecuteFn('EXTRACT_PERSON_DETAILS', extractPersonDetailsDef);
  static findRelevantPersonUrls = getExecuteFn(
    'FIND_RELEVANT_PERSON_URLS',
    findRelevantPersonUrlsDef,
  );
  static findRelevantUrls = getExecuteFn('FIND_RELEVANT_URLS', findRelevantUrlsDef);
  static generateCompanySummary = getExecuteFn(
    'GENERATE_COMPANY_SUMMARY',
    generateCompanySummaryDef,
  );
  static generateLabels = getExecuteFn('GENERATE_LABELS', generateLabelsDef);
  static generatePersonSummary = getExecuteFn('GENERATE_PERSON_SUMMARY', generatePersonSummaryDef);
  static generateShortSummary = getExecuteFn('GENERATE_SHORT_SUMMARY', generateShortSummaryDef);
  static generateTeaserSummary = getExecuteFn('GENERATE_TEASER_SUMMARY', generateTeaserSummaryDef);
  static getPitchDeckName = getExecuteFn('GET_PITCH_DECK_NAME', getPitchDeckNameDef);
  static identifyCompany = getExecuteFn('IDENTIFY_COMPANY', identifyCompanyDef);
  static identifyCompanySplittable = getExecuteFn(
    'IDENTIFY_COMPANY_SPLITTABLE',
    identifyCompanySplittableDef,
  );
  static identifyCompanyCompanyRelations = getExecuteFn(
    'IDENTIFY_COMPANY_COMPANY_RELATIONS',
    identifyCompanyCompanyRelationsDef,
  );
  static identifyCompanyPeopleRelations = getExecuteFn(
    'IDENTIFY_COMPANY_PEOPLE_RELATIONS',
    identifyCompanyPeopleRelationsDef,
  );
  static identifyCompanyRelatedEntities = getExecuteFn(
    'IDENTIFY_COMPANY_RELATED_ENTITIES',
    identifyCompanyRelatedEntitiesDef,
  );
  static identifyEntity = getExecuteFn('IDENTIFY_ENTITY', identifyEntityDef);
  static identifyEntityFromRequest = getExecuteFn(
    'IDENTIFY_ENTITY_FROM_REQUEST',
    identifyEntityFromRequestDef,
  );
  static identifyPersonRelatedEntities = getExecuteFn(
    'IDENTIFY_PERSON_RELATED_ENTITIES',
    identifyPersonRelatedEntitiesDef,
  );
  static identifyPeopleCompanyReplations = getExecuteFn(
    'IDENTIFY_PEOPLE_COMPANY_RELATIONS',
    identifyPeopleCompanyRelationsDef,
  );
  static identifySources = getExecuteFn('IDENTIFY_SOURCES', identifySourcesDef);
  static isMultiDealMessage = getExecuteFn('IS_MULTI_DEAL_MESSAGE', isMultiDealMessageDef);
  static matchFounderSearch = getExecuteFn('MATCH_FOUNDER_SEARCH', matchFounderSearchDef);
  static matchSearchResult = getExecuteFn('MATCH_SEARCH_RESULT', matchSearchResultDef);
  static parsePersonDisplay = getExecuteFn('PARSE_PERSON_DISPLAY', parsePersonDisplayDef);
  static processWebsite = getExecuteFn('PROCESS_WEBSITE', processWebsiteDef);
  static splitMessageIntoMultipleDeals = getExecuteFn(
    'SPLIT_MESSAGE_INTO_MULTIPLE_DEALS',
    splitMessageIntoMultipleDealsDef,
  );
  static textMerge = getExecuteFn('TEXT_MERGE', textMergeDef);
  static compressText = getExecuteFn('COMPRESS_TEXT', compressTextDef);
  static matchEntities = getExecuteFn('MATCH_ENTITIES', matchEntitiesDef);
  static fundraisingSoon = getExecuteFn('FUNDRAISING_SOON', fundraisingSoonDef);
  static parseTableFilters = getExecuteFn('PARSE_TABLE_FILTERS', parseTableFiltersDef);
}

export { Prompt };
