import CurrencyIsoCode from '../../generated/kysely/valuations/CurrencyIsoCode';

function getCurrencySign(currency: CurrencyIsoCode) {
  switch (currency.toUpperCase()) {
    case CurrencyIsoCode.CHF:
      return 'CHF';
    case CurrencyIsoCode.NOK:
    case CurrencyIsoCode.SEK:
    case CurrencyIsoCode.DKK:
      return 'kr';
    case CurrencyIsoCode.GBP:
      return '£';
    case CurrencyIsoCode.EUR:
      return '€';
    case CurrencyIsoCode.USD:
      return '$';
    default:
      return undefined;
  }
}

enum NumberAbbrSign {
  'THOUSAND' = 'K',
  'MILLION' = 'M',
  'BILLION' = 'BN',
}

const formatAbbr = (num: number, defaultFormat: string) => {
  if (num < 10 ** 4) {
    return defaultFormat;
  }

  if (num < 10 ** 6) {
    return `${Math.round(num / 10 ** 2) / 10}${NumberAbbrSign.THOUSAND}`;
  }

  if (num < 10 ** 9) {
    return `${Math.round(num / 10 ** 5) / 10}${NumberAbbrSign.MILLION}`;
  }

  if (num < 10 ** 12) {
    return `${Math.round(num / 10 ** 8) / 10}${NumberAbbrSign.BILLION}`;
  }

  return defaultFormat;
};

function formatMoney(
  sum?: number | null,
  config: {
    currency?: CurrencyIsoCode | null;
    maximumFractionDigits?: number;
    isAbbrFormat?: boolean;
  } = {
    maximumFractionDigits: 2,
    isAbbrFormat: false,
  },
) {
  if (sum === null || sum === undefined) {
    return '-';
  }

  const { currency, maximumFractionDigits, isAbbrFormat } = config;

  const formattedNumber = sum.toLocaleString(undefined, {
    maximumFractionDigits,
    minimumFractionDigits: maximumFractionDigits === 0 ? 0 : 2,
  });

  const resultNumber = isAbbrFormat ? formatAbbr(sum, formattedNumber) : formattedNumber;

  if (currency) {
    const currencySign = getCurrencySign(currency);

    return currencySign
      ? `${currencySign}${resultNumber}`
      : `${resultNumber} ${currency.toUpperCase()}`;
  } else {
    return resultNumber;
  }
}

export { formatMoney };
